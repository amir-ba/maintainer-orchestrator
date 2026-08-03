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
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const DEFAULT_DENIED_SHELL_COMMANDS = [
  'git push --force',
  'git push -f',
  'git reset --hard',
  'git clean',
  'git push upstream',
  'git push --tags',
  'git tag',
  'gh release',
  'yarn force-version',
  'lerna publish',
  'npx lerna publish',
  'npm publish',
  'yarn publish-telekom',
  'yarn prepare-neutral',
];

const WORKER_DENIED_SHELL_COMMANDS = ['gh project', 'gh pr merge'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

function validateResult(result) {
  if (!['ready', 'needs_owner', 'failed'].includes(result?.status)) {
    throw new Error('Worker result must have a supported status');
  }
  if (result.status === 'ready' && (!result.prUrl || !result.headSha)) {
    throw new Error('A ready worker result requires prUrl and headSha');
  }
  if (result.status === 'needs_owner' && (!result.reason || !result.comment)) {
    throw new Error('A needs_owner result requires a reason and comment');
  }
  return result;
}

function terminateProcess(child) {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
    return;
  }
  child.kill('SIGTERM');
}

function runProcess(command, arguments_, options) {
  return new Promise((resolve) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const heartbeat = setInterval(options.onHeartbeat, 30_000);
    heartbeat.unref();
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcess(child);
    }, options.timeoutMs);
    timeout.unref();

    child.on('error', (error) => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      resolve({ status: 1, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (status) => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      resolve({ status: status ?? 1, stdout, stderr, timedOut });
    });
  });
}

function createCopilotArguments(manifest, model, resultPath, prefixArguments) {
  const sessionArgument =
    manifest.attempt > 1
      ? `--resume=${manifest.sessionId}`
      : `--session-id=${manifest.sessionId}`;
  const deniedShellCommands = manifest.deniedShellCommands ??
    DEFAULT_DENIED_SHELL_COMMANDS;
  if (
    !Array.isArray(deniedShellCommands) ||
    !deniedShellCommands.every((command) => typeof command === 'string')
  ) {
    throw new Error('deniedShellCommands must be a string array');
  }

  return [
    ...prefixArguments,
    '-p',
    manifest.prompt,
    '-C',
    manifest.worktree,
    '--model',
    model,
    '--max-ai-credits',
    String(manifest.maxAiCredits ?? 30),
    '--no-ask-user',
    '--autopilot',
    '--max-autopilot-continues',
    String(manifest.maxAutopilotContinues ?? 20),
    '--output-format',
    'json',
    '--stream',
    'off',
    '--add-dir',
    dirname(resultPath),
    '--allow-tool=skill',
    '--allow-tool=write',
    '--allow-tool=shell',
    '--allow-url=github.com',
    ...[...new Set([...deniedShellCommands, ...WORKER_DENIED_SHELL_COMMANDS])]
      .map((command) => `--deny-tool=shell(${command})`),
    sessionArgument,
  ];
}

export async function runWorker({
  manifestPath,
  copilotCommand,
  copilotArguments = [],
  timeoutMs,
  environment = process.env,
}) {
  const manifest = readJson(manifestPath);
  const resultPath = manifest.resultPath ?? join(dirname(manifestPath), 'result.json');
  manifest.attempt = (manifest.attempt ?? 0) + 1;
  manifest.status = 'running';
  manifest.startedAt = new Date().toISOString();

  const updateHeartbeat = () => {
    manifest.heartbeatAt = new Date().toISOString();
    writeJsonAtomic(manifestPath, manifest);
  };
  updateHeartbeat();

  const models = [manifest.model];
  if (manifest.fallbackModel && manifest.fallbackModel !== manifest.model) {
    models.push(manifest.fallbackModel);
  }

  let processResult;
  for (const model of models) {
    if (existsSync(resultPath)) {
      unlinkSync(resultPath);
    }
    processResult = await runProcess(
      copilotCommand,
      createCopilotArguments(manifest, model, resultPath, copilotArguments),
      {
        cwd: manifest.worktree,
        timeoutMs,
        onHeartbeat: updateHeartbeat,
        env: {
          ...environment,
          SCALE_MAINTAINER_ATTEMPT: String(manifest.attempt),
          SCALE_MAINTAINER_RESULT_PATH: resultPath,
        },
      },
    );

    const unavailable = /Model .* is not available/i.test(processResult.stderr);
    if (!unavailable || model === models.at(-1)) {
      break;
    }
  }

  let result;
  try {
    result = validateResult(readJson(resultPath));
  } catch (error) {
    result = {
      status: 'failed',
      reason: processResult?.timedOut
        ? `Worker exceeded ${timeoutMs}ms`
        : error.message,
      exitCode: processResult?.status ?? 1,
    };
  }

  Object.assign(manifest, {
    status: result.status,
    completedAt: new Date().toISOString(),
    result,
  });
  updateHeartbeat();
  return result;
}

async function main() {
  const { values } = parseArgs({
    options: {
      manifest: { type: 'string' },
      'copilot-command': { type: 'string', default: 'copilot' },
      'copilot-arg': { type: 'string', multiple: true, default: [] },
      'timeout-ms': { type: 'string', default: '21600000' },
      json: { type: 'boolean', default: false },
    },
  });

  if (!values.manifest) {
    throw new Error('--manifest is required');
  }

  const result = await runWorker({
    manifestPath: values.manifest,
    copilotCommand: values['copilot-command'],
    copilotArguments: values['copilot-arg'],
    timeoutMs: Number.parseInt(values['timeout-ms'], 10),
  });
  process.stdout.write(`${JSON.stringify(result, null, values.json ? 0 : 2)}\n`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  await main();
}