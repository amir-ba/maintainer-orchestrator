/*
 * Scale https://github.com/telekom/scale
 *
 * Copyright (c) 2021 Egor Kirpichev and contributors, Deutsche Telekom AG
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createCommentArguments,
  createWorkerPrompt,
  createWorktreePlan,
} from '../orchestrator.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const orchestratorPath = resolve(testDirectory, '..', 'orchestrator.mjs');

function runOrchestrator(arguments_, environment = process.env) {
  return JSON.parse(
    execFileSync(process.execPath, [orchestratorPath, ...arguments_], {
      encoding: 'utf8',
      env: environment,
    }),
  );
}

test('prepares an existing pull request for review without creating another PR', () => {
  const item = {
    content: {
      type: 'PullRequest',
      number: 200,
      title: 'Fix select focus',
      url: 'https://github.com/telekom/scale/pull/200',
    },
  };
  const worktreePlan = createWorktreePlan(item);
  const prompt = createWorkerPrompt(
    {
      repository: 'telekom/scale',
      forkRepository: 'amir-ba/scale',
      projectOwner: 'amir-ba',
      projectNumber: 1,
    },
    item,
    {
      branch: worktreePlan.branch,
      resultPath: 'result.json',
    },
  );

  assert.deepEqual(worktreePlan.fetchArguments, [
    'fetch',
    'upstream',
    'pull/200/head',
  ]);
  assert.equal(worktreePlan.startPoint, 'FETCH_HEAD');
  assert.match(prompt, /scale-maintainer/);
  assert.match(prompt, /stenciljs-component-development/);
  assert.match(prompt, /github-deep-review` as the final gate/);
  assert.match(prompt, /read-only PR lane/);
  assert.match(prompt, /dispatcher owns Project changes and merges/);
  assert.match(prompt, /owner `amir-ba`, number `1`/);
  assert.match(prompt, /https:\/\/github\.com\/telekom\/scale\/pull\/200/);
  assert.doesNotMatch(prompt, /Autonomous Candidate criteria/);
  assert.deepEqual(createCommentArguments(item, 'Please fix the regression.'), [
    'pr',
    'comment',
    'https://github.com/telekom/scale/pull/200',
    '--body',
    'Please fix the regression.',
  ]);
});

test('issue workers follow the autonomous candidate review workflow', () => {
  const prompt = createWorkerPrompt(
    {
      repository: 'telekom/scale',
      forkRepository: 'amir-ba/scale',
      projectOwner: 'amir-ba',
      projectNumber: 1,
    },
    {
      content: {
        type: 'Issue',
        number: 201,
        url: 'https://github.com/telekom/scale/issues/201',
      },
    },
    { branch: 'copilot/issue-201-fix', resultPath: 'result.json' },
  );

  assert.match(prompt, /scale-maintainer/);
  assert.match(prompt, /stenciljs-component-development/);
  assert.match(prompt, /github-deep-review` as the final gate/);
  assert.match(prompt, /copilot\/issue-201-fix/);
  assert.match(prompt, /amir-ba\/scale/);
  assert.match(prompt, /telekom\/scale:main/);
  assert.match(prompt, /owner `amir-ba`, number `1`/);
  assert.match(prompt, /Only after the implementation and required local verification pass/);
  assert.doesNotMatch(prompt, /smallest meaningful regression coverage/);
});

test('foreign Autonomous items consume worker capacity without being adopted', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'scale-maintainer-'));
  const boardPath = join(stateDirectory, 'board.json');

  writeFileSync(
    boardPath,
    JSON.stringify({
      items: [
        {
          id: 'item-1',
          status: 'Autonomous',
          content: { type: 'Issue', number: 101 },
        },
        {
          id: 'item-2',
          status: 'Autonomous',
          content: { type: 'Issue', number: 102 },
        },
        {
          id: 'item-3',
          status: 'Backlog',
          content: { type: 'Issue', number: 103 },
        },
      ],
    }),
  );

  const result = runOrchestrator([
    '--board-file',
    boardPath,
    '--state-dir',
    stateDirectory,
    '--max-workers',
    '2',
    '--dry-run',
    '--json',
  ]);

  assert.equal(result.capacity.active, 2);
  assert.equal(result.capacity.foreign, 2);
  assert.equal(result.capacity.free, 0);
  assert.deepEqual(result.actions, []);
});

test('claims non-conflicting issues and pull requests by priority and age', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'scale-maintainer-'));
  const workersDirectory = join(stateDirectory, 'workers');
  const boardPath = join(stateDirectory, 'board.json');
  const triagePath = join(stateDirectory, 'triage.json');

  mkdirSync(workersDirectory);
  writeFileSync(
    join(workersDirectory, 'active.json'),
    JSON.stringify({
      itemId: 'active-item',
      locks: ['component:button'],
    }),
  );
  writeFileSync(
    boardPath,
    JSON.stringify({
      items: [
        {
          id: 'active-item',
          status: 'Autonomous',
          content: { type: 'Issue', number: 100 },
        },
        {
          id: 'pull-request',
          status: 'Backlog',
          priority: 'P0',
          createdAt: '2026-01-01T00:00:00Z',
          content: {
            type: 'PullRequest',
            number: 200,
            url: 'https://github.com/telekom/scale/pull/200',
          },
        },
        {
          id: 'button-item',
          status: 'Backlog',
          priority: 'P0',
          createdAt: '2026-01-02T00:00:00Z',
          content: { type: 'Issue', number: 101 },
        },
        {
          id: 'newer-input-item',
          status: 'Backlog',
          priority: 'P1',
          createdAt: '2026-01-04T00:00:00Z',
          content: { type: 'Issue', number: 103 },
        },
        {
          id: 'older-checkbox-item',
          status: 'Backlog',
          priority: 'P1',
          createdAt: '2026-01-03T00:00:00Z',
          content: { type: 'Issue', number: 102 },
        },
      ],
    }),
  );
  writeFileSync(
    triagePath,
    JSON.stringify({
      'pull-request': {
        eligible: true,
        locks: ['component:select'],
        verification: ['select.spec.tsx'],
      },
      'button-item': { eligible: true, locks: ['component:button'] },
      'newer-input-item': { eligible: true, locks: ['component:input'] },
      'older-checkbox-item': {
        eligible: true,
        locks: ['component:checkbox'],
      },
    }),
  );

  const result = runOrchestrator([
    '--board-file',
    boardPath,
    '--triage-file',
    triagePath,
    '--state-dir',
    stateDirectory,
    '--max-workers',
    '3',
    '--dry-run',
    '--json',
  ]);

  assert.deepEqual(
    result.actions.map(({ type, itemId }) => ({ type, itemId })),
    [
      { type: 'claim', itemId: 'pull-request' },
      { type: 'claim', itemId: 'older-checkbox-item' },
    ],
  );
});

test('releases locks owned by cards that are no longer Autonomous', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'scale-maintainer-'));
  const workersDirectory = join(stateDirectory, 'workers');
  const boardPath = join(stateDirectory, 'board.json');
  const triagePath = join(stateDirectory, 'triage.json');

  mkdirSync(workersDirectory);
  writeFileSync(
    join(workersDirectory, 'completed.json'),
    JSON.stringify({
      itemId: 'completed-item',
      status: 'done',
      locks: ['component:button'],
    }),
  );
  writeFileSync(
    boardPath,
    JSON.stringify({
      items: [
        {
          id: 'completed-item',
          status: 'Done',
          content: { type: 'Issue', number: 100 },
        },
        {
          id: 'button-item',
          status: 'Backlog',
          content: { type: 'Issue', number: 101 },
        },
      ],
    }),
  );
  writeFileSync(
    triagePath,
    JSON.stringify({
      'button-item': {
        eligible: true,
        locks: ['component:button'],
        verification: ['button.spec.tsx'],
      },
    }),
  );

  const result = runOrchestrator([
    '--board-file',
    boardPath,
    '--triage-file',
    triagePath,
    '--state-dir',
    stateDirectory,
    '--max-workers',
    '1',
    '--dry-run',
    '--json',
  ]);

  assert.equal(result.actions[0].type, 'claim');
  assert.equal(result.actions[0].itemId, 'button-item');
});

test('routes ineligible issues to Needs owner without consuming a slot', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'scale-maintainer-'));
  const boardPath = join(stateDirectory, 'board.json');
  const triagePath = join(stateDirectory, 'triage.json');

  writeFileSync(
    boardPath,
    JSON.stringify({
      items: [
        {
          id: 'claim-item',
          status: 'Backlog',
          priority: 'P0',
          createdAt: '2026-01-01T00:00:00Z',
          content: {
            type: 'Issue',
            number: 105,
            url: 'https://github.com/telekom/scale/issues/105',
          },
        },
        {
          id: 'decision-item',
          status: 'Backlog',
          priority: 'P1',
          createdAt: '2026-01-02T00:00:00Z',
          content: {
            type: 'Issue',
            number: 106,
            url: 'https://github.com/telekom/scale/issues/106',
          },
        },
      ],
    }),
  );
  writeFileSync(
    triagePath,
    JSON.stringify({
      'claim-item': {
        eligible: true,
        locks: ['component:button'],
        verification: ['button.spec.tsx'],
      },
      'decision-item': {
        eligible: false,
        locks: [],
        verification: [],
        blocker: 'Requires a design-token contract decision.',
        decisionBrief: 'Choose whether to retain the existing token contract.',
      },
    }),
  );

  const result = runOrchestrator([
    '--board-file',
    boardPath,
    '--triage-file',
    triagePath,
    '--state-dir',
    stateDirectory,
    '--max-workers',
    '1',
    '--dry-run',
    '--json',
  ]);

  assert.deepEqual(result.actions, [
    {
      type: 'claim',
      itemId: 'claim-item',
      itemType: 'Issue',
      issueNumber: 105,
      locks: ['component:button'],
      verification: ['button.spec.tsx'],
    },
    {
      type: 'needs_owner',
      itemId: 'decision-item',
      itemType: 'Issue',
      issueNumber: 106,
      issueUrl: 'https://github.com/telekom/scale/issues/106',
      blocker: 'Requires a design-token contract decision.',
      decisionBrief: 'Choose whether to retain the existing token contract.',
    },
  ]);
  assert.equal(result.capacity.free, 1);
});

test('normalizes triage locks and verification strings before creating claim actions', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'scale-maintainer-'));
  const boardPath = join(stateDirectory, 'board.json');
  const triagePath = join(stateDirectory, 'triage.json');

  writeFileSync(
    boardPath,
    JSON.stringify({
      items: [
        {
          id: 'pr-item',
          status: 'Backlog',
          priority: 'P0',
          createdAt: '2026-01-01T00:00:00Z',
          content: {
            type: 'PullRequest',
            number: 2540,
            url: 'https://github.com/telekom/scale/pull/2540',
          },
        },
      ],
    }),
  );
  writeFileSync(
    triagePath,
    JSON.stringify({
      'pr-item': {
        eligible: true,
        locks: ['component:components-\nangular'],
        verification: ['yarn workspace\n@telekom/scale-components-angular build'],
        rationale: 'Dependency bump review lane.',
      },
    }),
  );

  const result = runOrchestrator([
    '--board-file',
    boardPath,
    '--triage-file',
    triagePath,
    '--state-dir',
    stateDirectory,
    '--max-workers',
    '1',
    '--dry-run',
    '--json',
  ]);

  assert.deepEqual(result.actions, [
    {
      type: 'claim',
      itemId: 'pr-item',
      itemType: 'PullRequest',
      issueNumber: 2540,
      locks: ['component:components-angular'],
      verification: ['yarn workspace @telekom/scale-components-angular build'],
    },
  ]);
});

test('verifies the Project claim before launching a worker', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'scale-maintainer-live-'));
  const worktreeRoot = join(stateDirectory, 'worktrees');
  const boardStatePath = join(stateDirectory, 'board-state.json');
  const operationsPath = join(stateDirectory, 'operations.log');
  const configPath = join(stateDirectory, 'config.json');
  const fakeGhPath = join(stateDirectory, 'fake-gh.mjs');
  const fakeGitPath = join(stateDirectory, 'fake-git.mjs');
  const fakeCopilotPath = join(stateDirectory, 'fake-copilot.mjs');
  const fakeRunnerPath = join(stateDirectory, 'fake-runner.mjs');

  writeFileSync(
    boardStatePath,
    JSON.stringify({
      items: [
        {
          id: 'item-104',
          status: 'Backlog',
          priority: 'P0',
          createdAt: '2026-01-01T00:00:00Z',
          content: {
            type: 'Issue',
            number: 104,
            title: 'Fix button focus',
            url: 'https://github.com/telekom/scale/issues/104',
          },
        },
      ],
    }),
  );
  writeFileSync(
    fakeGhPath,
    `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const arguments_ = process.argv.slice(2);
const board = JSON.parse(readFileSync(process.env.BOARD_STATE_PATH, 'utf8'));
if (arguments_[0] === 'project' && arguments_[1] === 'item-list') {
  process.stdout.write(JSON.stringify(board));
} else if (arguments_[0] === 'project' && arguments_[1] === 'view') {
  process.stdout.write(JSON.stringify({ id: 'project-id' }));
} else if (arguments_[0] === 'project' && arguments_[1] === 'field-list') {
  process.stdout.write(JSON.stringify({ fields: [{
    id: 'status-field-id',
    name: 'Status',
    options: [
      { id: 'backlog-id', name: 'Backlog' },
      { id: 'autonomous-id', name: 'Autonomous' },
      { id: 'needs-owner-id', name: 'Needs owner' },
      { id: 'done-id', name: 'Done' }
    ]
  }] }));
} else if (arguments_[0] === 'project' && arguments_[1] === 'item-edit') {
  const itemId = arguments_[arguments_.indexOf('--id') + 1];
  const optionId = arguments_[arguments_.indexOf('--single-select-option-id') + 1];
  const statusById = { 'backlog-id': 'Backlog', 'autonomous-id': 'Autonomous', 'needs-owner-id': 'Needs owner', 'done-id': 'Done' };
  board.items.find((item) => item.id === itemId).status = statusById[optionId];
  writeFileSync(process.env.BOARD_STATE_PATH, JSON.stringify(board));
  appendFileSync(process.env.OPERATIONS_PATH, 'claim:' + itemId + '\\n');
} else {
  process.stderr.write('Unexpected gh arguments: ' + JSON.stringify(arguments_));
  process.exit(1);
}
`,
  );
  writeFileSync(
    fakeGitPath,
      `import { appendFileSync, mkdirSync } from 'node:fs';
const arguments_ = process.argv.slice(2);
appendFileSync(process.env.OPERATIONS_PATH, 'git:' + arguments_.join(' ') + '\\n');
if (arguments_[0] === 'show-ref') {
  process.exitCode = 1;
} else if (arguments_[0] === 'worktree' && arguments_[1] === 'add') {
  mkdirSync(arguments_[4]);
  } else if (arguments_[0] === 'rev-parse') {
    process.stdout.write('initial-head\\n');
}
`,
  );
  writeFileSync(
    fakeCopilotPath,
    `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.OPERATIONS_PATH, 'triage\\n');
process.stdout.write(JSON.stringify({
  eligible: true,
  locks: ['component:button'],
  verification: ['button.spec.tsx'],
  rationale: 'Public focus behavior has a bounded component implementation.'
}));
`,
  );
  writeFileSync(
    fakeRunnerPath,
    `import { appendFileSync } from 'node:fs';
const arguments_ = process.argv.slice(2);
appendFileSync(process.env.OPERATIONS_PATH, 'launch:' + arguments_[arguments_.indexOf('--manifest') + 1] + '\\n');
`,
  );
  writeFileSync(
    configPath,
    JSON.stringify({
      repositoryPath: stateDirectory,
      stateDirectory,
      worktreeRoot,
      projectOwner: 'amir-ba',
      projectNumber: 1,
      repository: 'telekom/scale',
      forkRepository: 'amir-ba/scale',
      maxWorkers: 5,
      maxTriage: 10,
      orchestratorModel: 'gpt-5.6-sol',
      workerModel: 'gpt-5.6-terra',
      fallbackModel: 'auto',
      maxAiCredits: 10,
      workerTimeoutMs: 5000,
      deniedShellCommands: ['git clean', 'npm publish'],
      copilotCommand: process.execPath,
      copilotArguments: [fakeCopilotPath],
      ghCommand: process.execPath,
      ghArguments: [fakeGhPath],
      gitCommand: process.execPath,
      gitArguments: [fakeGitPath],
      workerRunnerPath: fakeRunnerPath,
    }),
  );
  const staleWorktree = join(worktreeRoot, 'issue-104');
  mkdirSync(staleWorktree, { recursive: true });
  writeFileSync(join(staleWorktree, 'stale.txt'), 'stale');

  const result = runOrchestrator(
    [
      '--config',
      configPath,
      '--foreground-workers',
      '--json',
    ],
    {
      ...process.env,
      BOARD_STATE_PATH: boardStatePath,
      OPERATIONS_PATH: operationsPath,
    },
  );
  const board = JSON.parse(readFileSync(boardStatePath, 'utf8'));
  const operations = readFileSync(operationsPath, 'utf8').trim().split('\n');
  const manifest = JSON.parse(
    readFileSync(join(stateDirectory, 'workers', 'issue-104.json'), 'utf8'),
  );

  assert.equal(board.items[0].status, 'Autonomous');
  assert.equal(result.actions[0].type, 'claim');
  assert.equal(operations[0], 'triage');
  assert.match(operations.at(-2), /^claim:item-104$/);
  assert.match(operations.at(-1), /^launch:/);
  assert.ok(operations.some((operation) => operation.startsWith('git:worktree remove --force')));
  assert.ok(operations.some((operation) => operation === 'git:worktree prune'));
  assert.ok(operations.some((operation) => operation.startsWith('git:show-ref --verify --quiet refs/heads/copilot/issue-104-fix-button-focus')));
  assert.ok(operations.some((operation) => operation.startsWith('git:worktree add -b copilot/issue-104-fix-button-focus')));
  assert.match(manifest.prompt, /scale-maintainer/);
  assert.match(manifest.prompt, /stenciljs-component-development/);
  assert.match(manifest.prompt, /github-deep-review/);
  assert.equal(manifest.initialHeadSha, 'initial-head');
  assert.deepEqual(manifest.deniedShellCommands, ['git clean', 'npm publish']);
});