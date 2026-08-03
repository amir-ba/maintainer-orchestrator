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
const runnerPath = resolve(testDirectory, '..', 'triage-runner.mjs');

test('falls back to auto and returns validated read-only triage JSON', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scale-triage-'));
  const itemPath = join(directory, 'item.json');
  const invocationLogPath = join(directory, 'invocations.jsonl');
  const fakeCopilotPath = join(directory, 'fake-copilot.mjs');

  writeFileSync(
    itemPath,
    JSON.stringify({
      id: 'item-105',
      content: {
        type: 'Issue',
        number: 105,
        title: 'Fix checkbox focus',
        body: 'Checkbox focus is lost after validation.',
        url: 'https://github.com/telekom/scale/issues/105',
      },
    }),
  );
  writeFileSync(
    fakeCopilotPath,
    `import { appendFileSync } from 'node:fs';
const arguments_ = process.argv.slice(2);
appendFileSync(process.env.INVOCATION_LOG_PATH, JSON.stringify(arguments_) + '\\n');
if (arguments_.includes('gpt-5.6-sol')) {
  process.stderr.write('Model "gpt-5.6-sol" is not available.\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  eligible: true,
  locks: ['component:checkbox'],
  verification: ['checkbox.spec.tsx'],
  rationale: 'Bounded component bug with an existing spec seam.'
}));
`,
  );

  const output = execFileSync(
    process.execPath,
    [
      runnerPath,
      '--item',
      itemPath,
      '--repository',
      directory,
      '--project-owner',
      'amir-ba',
      '--project-number',
      '1',
      '--copilot-command',
      process.execPath,
      '--copilot-arg',
      fakeCopilotPath,
      '--model',
      'gpt-5.6-sol',
      '--fallback-model',
      'auto',
      '--json',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, INVOCATION_LOG_PATH: invocationLogPath },
    },
  );
  const result = JSON.parse(output);
  const invocations = readFileSync(invocationLogPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.deepEqual(result.locks, ['component:checkbox']);
  assert.equal(result.eligible, true);
  assert.equal(invocations.length, 2);
  assert.ok(invocations[0].includes('gpt-5.6-sol'));
  assert.ok(invocations[1].includes('auto'));
  assert.ok(invocations.every((arguments_) => !arguments_.includes('shell')));
  assert.ok(invocations.every((arguments_) => !arguments_.includes('write')));
  const prompt = invocations[0][invocations[0].indexOf('-p') + 1];
  assert.match(prompt, /scale-maintainer/);
  assert.match(prompt, /github-project-triage/);
  assert.match(prompt, /github-deep-review/);
  assert.match(prompt, /owner `amir-ba`, number `1`/);
  assert.match(prompt, /read-only triage instructions only/);
  assert.match(prompt, /"number":105/);
  assert.doesNotMatch(prompt, /Do not reject a pull request merely because/);
});

test('normalizes embedded newlines in locks and verification commands', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scale-triage-normalize-'));
  const itemPath = join(directory, 'item.json');
  const fakeCopilotPath = join(directory, 'fake-copilot-normalize.mjs');

  writeFileSync(
    itemPath,
    JSON.stringify({
      id: 'item-2540',
      content: {
        type: 'PullRequest',
        number: 2540,
        title: 'Bump dependency',
        url: 'https://github.com/telekom/scale/pull/2540',
      },
    }),
  );
  writeFileSync(
    fakeCopilotPath,
    `process.stdout.write(JSON.stringify({
  eligible: true,
  locks: ['component:components-\\nangular', 'component:components-react'],
  verification: ['yarn workspace\\n@telekom/scale-components-angular build', 'yarn format'],
  rationale: 'Safe dependency bump with bounded scope.'
}));
`,
  );

  const output = execFileSync(
    process.execPath,
    [
      runnerPath,
      '--item',
      itemPath,
      '--repository',
      directory,
      '--project-owner',
      'amir-ba',
      '--project-number',
      '1',
      '--copilot-command',
      process.execPath,
      '--copilot-arg',
      fakeCopilotPath,
      '--model',
      'auto',
      '--fallback-model',
      'auto',
      '--json',
    ],
    { encoding: 'utf8' },
  );
  const result = JSON.parse(output);

  assert.deepEqual(result.locks, [
    'component:components-angular',
    'component:components-react',
  ]);
  assert.deepEqual(result.verification, [
    'yarn workspace @telekom/scale-components-angular build',
    'yarn format',
  ]);
});

test('falls back when the preferred model returns malformed JSON', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scale-triage-malformed-'));
  const itemPath = join(directory, 'item.json');
  const invocationLogPath = join(directory, 'invocations.jsonl');
  const fakeCopilotPath = join(directory, 'fake-copilot-malformed.mjs');

  writeFileSync(
    itemPath,
    JSON.stringify({
      id: 'item-2539',
      content: {
        type: 'PullRequest',
        number: 2539,
        title: 'Update lint configuration',
        url: 'https://github.com/telekom/scale/pull/2539',
      },
    }),
  );
  writeFileSync(
    fakeCopilotPath,
    `import { appendFileSync } from 'node:fs';
const arguments_ = process.argv.slice(2);
appendFileSync(process.env.INVOCATION_LOG_PATH, JSON.stringify(arguments_) + '\\n');
if (arguments_.includes('gpt-5.6-sol')) {
  process.stdout.write('{"eligible":true,"locks":["component:lint"],"verification":["yarn lint" "yarn test"],"rationale":"Malformed"}');
} else {
  process.stdout.write(JSON.stringify({
    eligible: true,
    locks: ['component:lint'],
    verification: ['yarn lint'],
    rationale: 'Fallback returned valid JSON.'
  }));
}
`,
  );

  const output = execFileSync(
    process.execPath,
    [
      runnerPath,
      '--item',
      itemPath,
      '--repository',
      directory,
      '--project-owner',
      'amir-ba',
      '--project-number',
      '1',
      '--copilot-command',
      process.execPath,
      '--copilot-arg',
      fakeCopilotPath,
      '--model',
      'gpt-5.6-sol',
      '--fallback-model',
      'auto',
      '--json',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, INVOCATION_LOG_PATH: invocationLogPath },
    },
  );
  const invocations = readFileSync(invocationLogPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.equal(JSON.parse(output).eligible, true);
  assert.equal(invocations.length, 2);
  assert.ok(invocations[0].includes('gpt-5.6-sol'));
  assert.ok(invocations[1].includes('auto'));
});