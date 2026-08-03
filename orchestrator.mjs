/*
 * Scale https://github.com/telekom/scale
 *
 * Copyright (c) 2021 Egor Kirpichev and contributors, Deutsche Telekom AG
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { triageItem } from './triage-runner.mjs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function applyConfiguredProxy(config) {
  if (!config?.httpProxy) {
    return;
  }
  process.env.http_proxy = config.httpProxy;
  process.env.HTTP_PROXY = config.httpProxy;
  process.env.https_proxy = config.httpProxy;
  process.env.HTTPS_PROXY = config.httpProxy;
}

function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

function acquireLock(stateDirectory) {
  mkdirSync(stateDirectory, { recursive: true });
  const lockPath = join(stateDirectory, 'orchestrator.lock');
  try {
    const descriptor = openSync(lockPath, 'wx');
    writeFileSync(descriptor, String(process.pid));
    closeSync(descriptor);
    return () => unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
    return null;
  }
}

function execute(command, prefixArguments, arguments_, options = {}) {
  const result = spawnSync(command, [...prefixArguments, ...arguments_], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(' ')} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function createClient(config, name) {
  return {
    command: config[`${name}Command`] ?? name,
    arguments: config[`${name}Arguments`] ?? [],
  };
}

function runClient(client, arguments_, options) {
  return execute(client.command, client.arguments, arguments_, options);
}

function fetchBoard(config, gh) {
  return JSON.parse(
    runClient(gh, [
      'project',
      'item-list',
      String(config.projectNumber),
      '--owner',
      config.projectOwner,
      '--limit',
      '100',
      '--format',
      'json',
    ]),
  );
}

function readProjectMetadata(config, gh) {
  const project = JSON.parse(
    runClient(gh, [
      'project',
      'view',
      String(config.projectNumber),
      '--owner',
      config.projectOwner,
      '--format',
      'json',
    ]),
  );
  const fields = JSON.parse(
    runClient(gh, [
      'project',
      'field-list',
      String(config.projectNumber),
      '--owner',
      config.projectOwner,
      '--format',
      'json',
    ]),
  );
  const statusField = fields.fields.find(({ name }) => name === 'Status');
  if (!project.id || !statusField?.id) {
    throw new Error('Project and Status field IDs are required');
  }

  return {
    projectId: project.id,
    statusFieldId: statusField.id,
    statusOptions: Object.fromEntries(
      statusField.options.map(({ id, name }) => [name, id]),
    ),
  };
}

function moveItem(config, gh, metadata, itemId, status) {
  const optionId = metadata.statusOptions[status];
  if (!optionId) {
    throw new Error(`Project status does not exist: ${status}`);
  }
  runClient(gh, [
    'project',
    'item-edit',
    '--id',
    itemId,
    '--project-id',
    metadata.projectId,
    '--field-id',
    metadata.statusFieldId,
    '--single-select-option-id',
    optionId,
  ]);
}

export function createCommentArguments(item, body) {
  const command = item.content?.type === 'PullRequest' ? 'pr' : 'issue';
  return [command, 'comment', item.content.url, '--body', body];
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

export function createWorktreePlan(item) {
  const slug = slugify(item.content.title ?? String(item.content.number));
  if (item.content.type === 'PullRequest') {
    return {
      branch: `copilot/pr-${item.content.number}-${slug}`,
      directory: `pr-${item.content.number}`,
      fetchArguments: [
        'fetch',
        'upstream',
        `pull/${item.content.number}/head`,
      ],
      startPoint: 'FETCH_HEAD',
    };
  }
  return {
    branch: `copilot/issue-${item.content.number}-${slug}`,
    directory: `issue-${item.content.number}`,
    fetchArguments: ['fetch', 'upstream', '--prune'],
    startPoint: 'upstream/main',
  };
}

function prepareWorktree(config, git, item) {
  const plan = createWorktreePlan(item);
  const worktree = join(config.worktreeRoot, plan.directory);
  mkdirSync(config.worktreeRoot, { recursive: true });
  runClient(git, plan.fetchArguments, {
    cwd: config.repositoryPath,
  });
  try {
    runClient(git, ['worktree', 'remove', '--force', worktree], {
      cwd: config.repositoryPath,
    });
  } catch {
    // The worktree may not exist yet.
  }

  let branchExists = true;
  try {
    runClient(git, ['show-ref', '--verify', '--quiet', `refs/heads/${plan.branch}`], {
      cwd: config.repositoryPath,
    });
  } catch {
    branchExists = false;
  }
  runClient(
    git,
    branchExists
      ? ['worktree', 'add', worktree, plan.branch]
      : ['worktree', 'add', '-b', plan.branch, worktree, plan.startPoint],
    { cwd: config.repositoryPath },
  );
  const initialHeadSha = runClient(git, ['rev-parse', 'HEAD'], {
    cwd: worktree,
  }).trim();
  return { branch: plan.branch, worktree, initialHeadSha };
}

export function createWorkerPrompt(config, item, manifest) {
  if (item.content.type === 'PullRequest') {
    return `Invoke \`scale-maintainer\`, \`stenciljs-component-development\`, then \`github-deep-review\` as the final gate. Review ${item.content.url} at the exact head in this isolated worktree and run the applicable verification: ${JSON.stringify(manifest.verification ?? [])}.
For every invoked skill, the configured GitHub Project is owner \`${config.projectOwner}\`, number \`${config.projectNumber}\`.
This is a read-only PR lane: do not modify files, commit, push, or open another PR. The dispatcher owns Project changes and merges.
Write exactly one JSON object to ${manifest.resultPath}: {"status":"ready","prUrl":"${item.content.url}","headSha":"<git rev-parse HEAD>"}, {"status":"needs_owner","reason":"...","comment":"decision-ready PR review"}, or {"status":"failed","reason":"..."}.`;
  }
  return `Invoke \`scale-maintainer\`, \`stenciljs-component-development\`, then \`github-deep-review\` as the final gate. Implement ${item.content.url} in this isolated worktree and run the triage verification: ${JSON.stringify(manifest.verification ?? [])}.
For every invoked skill, the configured GitHub Project is owner \`${config.projectOwner}\`, number \`${config.projectNumber}\`.
Only after the implementation and required local verification pass, push ${manifest.branch} to ${config.forkRepository} and open a PR against ${config.repository}:main. The dispatcher owns Project changes and merges.
Write exactly one JSON object to ${manifest.resultPath}: {"status":"ready","prUrl":"...","headSha":"..."}, {"status":"needs_owner","reason":"...","comment":"decision-ready comment"}, or {"status":"failed","reason":"..."}.`;
}

function launchWorker(config, manifestPath, foreground) {
  const runnerPath =
    config.workerRunnerPath ?? join(dirname(import.meta.filename), 'worker-runner.mjs');
  const arguments_ = [
    runnerPath,
    '--manifest',
    manifestPath,
    '--timeout-ms',
    String(config.workerTimeoutMs),
  ];

  if (foreground) {
    execute(process.execPath, [], arguments_, { cwd: config.repositoryPath });
    return;
  }

  const logsDirectory = join(config.stateDirectory, 'logs');
  mkdirSync(logsDirectory, { recursive: true });
  const output = openSync(
    join(logsDirectory, `${Date.now()}-${manifestPath.split(/[\\/]/).at(-1)}.log`),
    'a',
  );
  const child = spawn(process.execPath, arguments_, {
    cwd: config.repositoryPath,
    detached: true,
    stdio: ['ignore', output, output],
    windowsHide: true,
  });
  child.unref();
  closeSync(output);
}

function executeActions({ config, board, plan, gh, git, foreground }) {
  if (plan.actions.length === 0) {
    return;
  }
  const metadata = readProjectMetadata(config, gh);
  const workersDirectory = join(config.stateDirectory, 'workers');
  mkdirSync(workersDirectory, { recursive: true });

  for (const action of plan.actions) {
    const item = board.items.find(({ id }) => id === action.itemId);
    if (action.type === 'needs_owner') {
      runClient(gh, createCommentArguments(item, action.decisionBrief));
      moveItem(config, gh, metadata, item.id, 'Needs owner');
      continue;
    }

    const prepared = prepareWorktree(config, git, item);
    moveItem(config, gh, metadata, item.id, 'Autonomous');
    const refreshed = fetchBoard(config, gh);
    const claimed = refreshed.items.find(({ id }) => id === item.id);
    if (claimed?.status !== 'Autonomous') {
      throw new Error(`Project claim verification failed for ${item.content.url}`);
    }

    const manifestPrefix =
      item.content.type === 'PullRequest' ? 'pr' : 'issue';
    const manifestPath = join(
      workersDirectory,
      `${manifestPrefix}-${item.content.number}.json`,
    );
    const manifest = {
      itemId: item.id,
      itemType: item.content.type,
      itemNumber: item.content.number,
      itemUrl: item.content.url,
      issueNumber: item.content.number,
      issueUrl: item.content.url,
      title: item.content.title,
      locks: action.locks,
      verification: action.verification,
      branch: prepared.branch,
      worktree: prepared.worktree,
      initialHeadSha: prepared.initialHeadSha,
      sessionId: randomUUID(),
      attempt: 0,
      status: 'launching',
      createdAt: new Date().toISOString(),
      model: config.workerModel,
      fallbackModel: config.fallbackModel,
      maxAiCredits: config.maxAiCredits,
      deniedShellCommands: config.deniedShellCommands,
      resultPath: join(
        workersDirectory,
        `${manifestPrefix}-${item.content.number}-result.json`,
      ),
    };
    manifest.prompt = createWorkerPrompt(config, item, manifest);
    writeJsonAtomic(manifestPath, manifest);
    launchWorker(config, manifestPath, foreground);
  }
}

function persistManifest(manifest) {
  const { manifestPath, ...value } = manifest;
  writeJsonAtomic(manifestPath, value);
}

function executeReconciliation({ config, board, gh, git, foreground }) {
  const actions = createReconciliationPlan({
    manifests: readWorkerManifests(config.stateDirectory),
    heartbeatStaleMs: config.heartbeatStaleMs,
    maxAttempts: config.maxAttempts,
  });
  if (actions.length === 0) {
    return false;
  }

  let metadata;
  let boardChanged = false;
  for (const action of actions) {
    const { manifest } = action;
    const item = board.items.find(({ id }) => id === manifest.itemId);
    if (!item || item.status !== 'Autonomous') {
      continue;
    }
    if (action.type === 'retry') {
      Object.assign(manifest, normalizeManifestForWorker(manifest));
      manifest.prompt = createWorkerPrompt(
        config,
        { content: createContentFromManifest(manifest) },
        manifest,
      );
      persistManifest(manifest);
      launchWorker(config, manifest.manifestPath, foreground);
      continue;
    }
    if (action.type === 'needs_owner') {
      metadata ??= readProjectMetadata(config, gh);
      runClient(gh, createCommentArguments(item, action.comment));
      moveItem(config, gh, metadata, item.id, 'Needs owner');
      manifest.status = 'escalated';
      manifest.escalatedAt = new Date().toISOString();
      persistManifest(manifest);
      boardChanged = true;
      continue;
    }

    const pullRequest = JSON.parse(
      runClient(gh, [
        'pr',
        'view',
        manifest.result.prUrl,
        '--json',
        'headRefOid,baseRefName,isDraft,mergeable',
      ]),
    );
    const checks = JSON.parse(
      runClient(gh, [
        'pr',
        'checks',
        manifest.result.prUrl,
        '--json',
        'name,bucket',
      ]),
    );
    const worktreeStatus = manifest.worktree
      ? runClient(git, ['status', '--porcelain'], { cwd: manifest.worktree }).trim()
      : null;
    const worktreeHeadSha = manifest.worktree
      ? runClient(git, ['rev-parse', 'HEAD'], { cwd: manifest.worktree }).trim()
      : null;
    const validation = validatePullRequest({
      manifest,
      pullRequest,
      checks,
      config,
      worktreeStatus,
      worktreeHeadSha,
    });
    if (!validation.ready) {
      continue;
    }

    metadata ??= readProjectMetadata(config, gh);
    runClient(gh, ['pr', 'merge', manifest.result.prUrl, '--squash']);
    moveItem(config, gh, metadata, item.id, 'Done');
    manifest.status = 'done';
    manifest.mergedAt = new Date().toISOString();
    persistManifest(manifest);
    boardChanged = true;
  }
  return boardChanged;
}

function readWorkerManifests(stateDirectory) {
  const workersDirectory = join(stateDirectory, 'workers');
  if (!existsSync(workersDirectory)) {
    return [];
  }

  return readdirSync(workersDirectory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({
      ...readJson(join(workersDirectory, name)),
      manifestPath: join(workersDirectory, name),
    }))
    .filter(({ itemId }) => itemId);
}

export function createReconciliationPlan({
  manifests,
  now = new Date(),
  heartbeatStaleMs = 5 * 60 * 1000,
  maxAttempts = 3,
}) {
  const actions = [];
  for (const manifest of manifests) {
    const heartbeatTime = Date.parse(
      manifest.heartbeatAt ?? manifest.createdAt ?? '',
    );
    const stale =
      ['launching', 'running'].includes(manifest.status) &&
      (!Number.isFinite(heartbeatTime) ||
        now.getTime() - heartbeatTime > heartbeatStaleMs);

    if ((manifest.status === 'failed' || stale) && manifest.attempt < maxAttempts) {
      actions.push({ type: 'retry', itemId: manifest.itemId, manifest });
      continue;
    }
    if (
      manifest.status === 'needs_owner' ||
      ((manifest.status === 'failed' || stale) && manifest.attempt >= maxAttempts)
    ) {
      const reason = manifest.result?.reason ?? 'Worker heartbeat expired.';
      actions.push({
        type: 'needs_owner',
        itemId: manifest.itemId,
        manifest,
        reason,
        comment:
          manifest.result?.comment ??
          `Automation stopped after ${manifest.attempt} attempts: ${reason}`,
      });
      continue;
    }
    if (manifest.status === 'ready') {
      actions.push({ type: 'inspect_ready', itemId: manifest.itemId, manifest });
    }
  }
  return actions;
}

export function validatePullRequest({
  manifest,
  pullRequest,
  checks,
  config,
  worktreeStatus,
  worktreeHeadSha,
}) {
  const prUrl = manifest.result?.prUrl ?? '';
  const validRepository = prUrl.startsWith(
    `https://github.com/${config.repository}/pull/`,
  );
  if (
    !validRepository ||
    pullRequest.headRefOid !== manifest.result?.headSha ||
    worktreeHeadSha !== manifest.result?.headSha ||
    worktreeStatus !== '' ||
    (manifest.itemType === 'PullRequest' &&
      manifest.initialHeadSha !== manifest.result?.headSha) ||
    pullRequest.baseRefName !== 'main' ||
    pullRequest.isDraft ||
    pullRequest.mergeable !== 'MERGEABLE'
  ) {
    return { ready: false, reason: 'Pull request identity or merge state changed.' };
  }

  const checkBuckets = new Map(checks.map(({ name, bucket }) => [name, bucket]));
  const incomplete = config.requiredChecks.filter(
    (name) => checkBuckets.get(name) !== 'pass',
  );
  if (incomplete.length > 0) {
    return {
      ready: false,
      reason: `Required checks are not successful: ${incomplete.join(', ')}`,
    };
  }
  return { ready: true };
}

function compareCandidates(left, right) {
  const priorityOrder = { P0: 0, P1: 1, P2: 2 };
  const priorityDifference =
    (priorityOrder[left.priority] ?? 3) -
    (priorityOrder[right.priority] ?? 3);

  return (
    priorityDifference ||
    String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
  );
}

function hasConflict(locks, activeLocks) {
  return locks.some((lock) => activeLocks.has(lock));
}

function normalizeLock(lock) {
  return String(lock ?? '')
    .replace(/\s+/g, '')
    .trim();
}

function normalizeVerificationCommand(command) {
  return String(command ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeStringArray(values, normalizer) {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.map((value) => normalizer(value)).filter(Boolean))];
}

function normalizeManifestForWorker(manifest) {
  return {
    ...manifest,
    locks: normalizeStringArray(manifest.locks, normalizeLock),
    verification: normalizeStringArray(
      manifest.verification,
      normalizeVerificationCommand,
    ),
  };
}

function createContentFromManifest(manifest) {
  return {
    type: manifest.itemType,
    number: manifest.itemNumber,
    title: manifest.title,
    url: manifest.itemUrl,
  };
}

function getCandidates(board, maxTriage) {
  return board.items
    .filter(
      (item) =>
        item.status === 'Backlog' &&
        ['Issue', 'PullRequest'].includes(item.content?.type),
    )
    .sort(compareCandidates)
    .slice(0, maxTriage);
}

export function createDispatchPlan({
  board,
  stateDirectory,
  maxWorkers,
  triage = {},
  maxTriage = 10,
}) {
  const activeItems = board.items.filter(
    (item) => item.status === 'Autonomous',
  );
  const manifests = readWorkerManifests(stateDirectory);
  const activeItemIds = new Set(activeItems.map(({ id }) => id));
  const activeManifests = manifests.filter(({ itemId }) =>
    activeItemIds.has(itemId),
  );
  const ownedItemIds = new Set(manifests.map(({ itemId }) => itemId));
  const owned = activeItems.filter((item) => ownedItemIds.has(item.id)).length;
  const foreign = activeItems.length - owned;
  const free = Math.max(0, maxWorkers - activeItems.length);
  const activeLocks = new Set(
    activeManifests.flatMap(({ locks = [] }) =>
      normalizeStringArray(locks, normalizeLock),
    ),
  );
  const actions = [];
  let claimCount = 0;
  const candidates = getCandidates(board, maxTriage);

  for (const item of candidates) {
    const result = triage[item.id];
    if (!result) {
      continue;
    }
    const locks = normalizeStringArray(result.locks, normalizeLock);
    const verification = normalizeStringArray(
      result.verification,
      normalizeVerificationCommand,
    );
    if (!result.eligible) {
      actions.push({
        type: 'needs_owner',
        itemId: item.id,
        itemType: item.content.type,
        issueNumber: item.content.number,
        issueUrl: item.content.url,
        blocker: result.blocker,
        decisionBrief: result.decisionBrief,
      });
      continue;
    }
    if (claimCount >= free) {
      continue;
    }
    if (hasConflict(locks, activeLocks)) {
      continue;
    }

    actions.push({
      type: 'claim',
      itemId: item.id,
      itemType: item.content.type,
      issueNumber: item.content.number,
      locks,
      verification,
    });
    claimCount += 1;
    for (const lock of locks) {
      activeLocks.add(lock);
    }
  }

  return {
    capacity: {
      max: maxWorkers,
      active: activeItems.length,
      owned,
      foreign,
      free,
    },
    actions,
  };
}

function runLiveTriage(config, board) {
  const active = board.items.filter(
    ({ status }) => status === 'Autonomous',
  ).length;
  const free = Math.max(0, config.maxWorkers - active);
  if (free === 0) {
    return {};
  }

  const triage = {};
  const activeItemIds = new Set(
    board.items
      .filter(({ status }) => status === 'Autonomous')
      .map(({ id }) => id),
  );
  const activeLocks = new Set(
    readWorkerManifests(config.stateDirectory)
      .filter(({ itemId }) => activeItemIds.has(itemId))
      .flatMap(({ locks = [] }) => normalizeStringArray(locks, normalizeLock)),
  );
  let claimable = 0;
  for (const item of getCandidates(board, config.maxTriage)) {
    if (claimable >= free) {
      break;
    }
    try {
      triage[item.id] = triageItem({
        item,
        repository: config.repositoryPath,
        projectOwner: config.projectOwner,
        projectNumber: config.projectNumber,
        copilotCommand: config.copilotCommand ?? 'copilot',
        copilotArguments: config.copilotArguments ?? [],
        model: config.orchestratorModel,
        fallbackModel: config.fallbackModel,
        maxAiCredits: config.maxAiCredits,
      });
      const result = triage[item.id];
      const locks = normalizeStringArray(result.locks, normalizeLock);
      if (result.eligible && !hasConflict(locks, activeLocks)) {
        claimable += 1;
        for (const lock of locks) {
          activeLocks.add(lock);
        }
      }
    } catch (error) {
      triage[item.id] = null;
      process.stderr.write(
        `Triage failed for ${item.content.url}: ${error.message}\n`,
      );
    }
  }
  return triage;
}

function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      'board-file': { type: 'string' },
      'triage-file': { type: 'string' },
      'state-dir': { type: 'string' },
      'max-workers': { type: 'string', default: '5' },
      'max-triage': { type: 'string', default: '10' },
      'dry-run': { type: 'boolean', default: false },
      'foreground-workers': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });

  const config = values.config ? readJson(values.config) : null;
  if (!config && (!values['board-file'] || !values['state-dir'])) {
    throw new Error('--config or both --board-file and --state-dir are required');
  }

  applyConfiguredProxy(config);
  const gh = config ? createClient(config, 'gh') : null;
  const git = config ? createClient(config, 'git') : null;
  let board = values['board-file']
    ? readJson(values['board-file'])
    : fetchBoard(config, gh);
  const stateDirectory = config?.stateDirectory ?? values['state-dir'];
  const releaseLock = acquireLock(stateDirectory);
  if (!releaseLock) {
    process.stdout.write(`${JSON.stringify({ status: 'already_running' })}\n`);
    return;
  }

  const logsDirectory = join(stateDirectory, 'logs');
  mkdirSync(logsDirectory, { recursive: true });
  const runDate = new Date();
  // one log file per day; each 15-min tick appends a run entry
  const orchestratorLogPath = join(
    logsDirectory,
    `orchestrator-${runDate.toISOString().slice(0, 10)}.log`,
  );
  const runLines = [];
  const log = (msg) => runLines.push(msg);

  log(`=== run start ${runDate.toISOString()} pid=${process.pid} ===`);

  let runError = null;
  try {
  if (
    config &&
    !values['dry-run'] &&
    executeReconciliation({
      config,
      board,
      gh,
      git,
      foreground: values['foreground-workers'],
    })
  ) {
    board = fetchBoard(config, gh);
  }
  const triage = values['triage-file']
    ? readJson(values['triage-file'])
    : config
      ? runLiveTriage(config, board)
      : {};

  const plan = createDispatchPlan({
    board,
    stateDirectory,
    maxWorkers: config?.maxWorkers ?? Number.parseInt(values['max-workers'], 10),
    maxTriage: config?.maxTriage ?? Number.parseInt(values['max-triage'], 10),
    triage,
  });

  if (config && !values['dry-run']) {
    executeActions({
      config,
      board,
      plan,
      gh,
      git,
      foreground: values['foreground-workers'],
    });
  }

  log(`capacity: max=${plan.capacity.max} active=${plan.capacity.active} free=${plan.capacity.free}`);
  log(`actions: ${plan.actions.map((a) => `${a.type}(${a.issueNumber ?? a.itemId})`).join(', ') || 'none'}`);
  process.stdout.write(`${JSON.stringify(plan, null, values.json ? 0 : 2)}\n`);
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    if (runError) {
      log(`error: ${runError.message}`);
    }
    log(`=== run end ${new Date().toISOString()} status=${runError ? 'error' : 'ok'} ===\n`);
    appendFileSync(orchestratorLogPath, runLines.join('\n') + '\n');
    releaseLock();
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main();
}