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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const runnerPath = resolve(testDirectory, '..', 'worker-runner.mjs');

test('falls back to auto when the requested worker model is unavailable', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'scale-worker-'));
  const manifestPath = join(stateDirectory, 'manifest.json');
  const invocationLogPath = join(stateDirectory, 'invocations.jsonl');
  const fakeCopilotPath = join(stateDirectory, 'fake-copilot.mjs');

  writeFileSync(
    fakeCopilotPath,
    `import { appendFileSync, writeFileSync } from 'node:fs';
const arguments_ = process.argv.slice(2);
appendFileSync(process.env.INVOCATION_LOG_PATH, JSON.stringify(arguments_) + '\\n');
if (arguments_.includes('gpt-5.6-terra')) {
  process.stderr.write('Model "gpt-5.6-terra" is not available.\\n');
  process.exit(1);
}
writeFileSync(process.env.SCALE_MAINTAINER_RESULT_PATH, JSON.stringify({
  status: 'ready',
  prUrl: 'https://github.com/telekom/scale/pull/999',
  headSha: 'abc123'
}));
`,
  );
  writeFileSync(
    manifestPath,
    JSON.stringify({
      itemId: 'item-999',
      issueNumber: 999,
      sessionId: '00000000-0000-4000-8000-000000000999',
      worktree: stateDirectory,
      attempt: 0,
      model: 'gpt-5.6-terra',
      fallbackModel: 'auto',
      deniedShellCommands: ['git clean', 'npm publish'],
      prompt: 'Implement issue 999 and write the required result.',
    }),
  );

  const output = execFileSync(
    process.execPath,
    [
      runnerPath,
      '--manifest',
      manifestPath,
      '--copilot-command',
      process.execPath,
      '--copilot-arg',
      fakeCopilotPath,
      '--timeout-ms',
      '5000',
      '--json',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, INVOCATION_LOG_PATH: invocationLogPath },
    },
  );
  const result = JSON.parse(output);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const invocations = readFileSync(invocationLogPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.equal(result.status, 'ready');
  assert.equal(manifest.attempt, 1);
  assert.equal(manifest.status, 'ready');
  assert.equal(invocations.length, 2);
  assert.ok(invocations[0].includes('gpt-5.6-terra'));
  assert.ok(invocations[1].includes('auto'));
  assert.ok(
    invocations.every((arguments_) => arguments_.includes('--allow-tool=skill')),
  );
  for (const denied of [
    '--deny-tool=shell(gh project)',
    '--deny-tool=shell(gh pr merge)',
    '--deny-tool=shell(git clean)',
    '--deny-tool=shell(npm publish)',
  ]) {
    assert.ok(invocations.every((arguments_) => arguments_.includes(denied)));
  }
  assert.ok(
    invocations.every(
      (arguments_) => !arguments_.includes('--deny-tool=shell(git push upstream)'),
    ),
  );
});