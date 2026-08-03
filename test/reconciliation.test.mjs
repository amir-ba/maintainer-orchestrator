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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createReconciliationPlan,
  validatePullRequest,
} from '../orchestrator.mjs';

const requiredChecks = [
  'prettier',
  'tslint',
  'unit-tests',
  'e2e-tests',
  'visual-tests',
  'wrapper-build',
];
const testDirectory = dirname(fileURLToPath(import.meta.url));
const orchestratorPath = resolve(testDirectory, '..', 'orchestrator.mjs');

test('retries dead workers twice and escalates after the third attempt', () => {
  const now = new Date('2026-08-03T18:30:00Z');
  const manifests = [
    {
      itemId: 'fresh',
      status: 'running',
      attempt: 1,
      heartbeatAt: '2026-08-03T18:29:00Z',
    },
    {
      itemId: 'stale',
      status: 'running',
      attempt: 1,
      heartbeatAt: '2026-08-03T18:20:00Z',
    },
    { itemId: 'failed-twice', status: 'failed', attempt: 2 },
    {
      itemId: 'failed-third',
      status: 'failed',
      attempt: 3,
      result: { reason: 'Tests still fail.' },
    },
    {
      itemId: 'decision',
      status: 'needs_owner',
      attempt: 1,
      result: { reason: 'API choice required.', comment: 'Choose API A or B.' },
    },
    {
      itemId: 'ready',
      status: 'ready',
      attempt: 1,
      result: {
        prUrl: 'https://github.com/telekom/scale/pull/999',
        headSha: 'abc123',
      },
    },
  ];

  assert.deepEqual(
    createReconciliationPlan({
      manifests,
      now,
      heartbeatStaleMs: 5 * 60 * 1000,
      maxAttempts: 3,
    }),
    [
      { type: 'retry', itemId: 'stale', manifest: manifests[1] },
      { type: 'retry', itemId: 'failed-twice', manifest: manifests[2] },
      {
        type: 'needs_owner',
        itemId: 'failed-third',
        manifest: manifests[3],
        reason: 'Tests still fail.',
        comment: 'Automation stopped after 3 attempts: Tests still fail.',
      },
      {
        type: 'needs_owner',
        itemId: 'decision',
        manifest: manifests[4],
        reason: 'API choice required.',
        comment: 'Choose API A or B.',
      },
      { type: 'inspect_ready', itemId: 'ready', manifest: manifests[5] },
    ],
  );
});

test('requires the exact head and all six successful checks before merge', () => {
  const manifest = {
    result: {
      prUrl: 'https://github.com/telekom/scale/pull/999',
      headSha: 'abc123',
    },
  };
  const pullRequest = {
    headRefOid: 'abc123',
    baseRefName: 'main',
    isDraft: false,
    mergeable: 'MERGEABLE',
  };
  const checks = requiredChecks.map((name) => ({ name, bucket: 'pass' }));
  const config = { repository: 'telekom/scale', requiredChecks };

  assert.deepEqual(
    validatePullRequest({
      manifest,
      pullRequest,
      checks,
      config,
      worktreeStatus: '',
      worktreeHeadSha: 'abc123',
    }),
    { ready: true },
  );
  assert.equal(
    validatePullRequest({
      manifest,
      pullRequest: { ...pullRequest, headRefOid: 'new-head' },
      checks,
      config,
      worktreeStatus: '',
      worktreeHeadSha: 'abc123',
    }).ready,
    false,
  );
  assert.equal(
    validatePullRequest({
      manifest,
      pullRequest,
      checks: checks.slice(0, -1),
      config,
      worktreeStatus: '',
      worktreeHeadSha: 'abc123',
    }).ready,
    false,
  );
  assert.equal(
    validatePullRequest({
      manifest,
      pullRequest,
      checks: checks.map((check) =>
        check.name === 'visual-tests' ? { ...check, bucket: 'fail' } : check,
      ),
      config,
      worktreeStatus: '',
      worktreeHeadSha: 'abc123',
    }).ready,
    false,
  );
  assert.equal(
    validatePullRequest({
      manifest,
      pullRequest,
      checks,
      config,
      worktreeStatus: ' M packages/components/button.tsx',
      worktreeHeadSha: 'abc123',
    }).ready,
    false,
  );
  assert.equal(
    validatePullRequest({
      manifest: {
        ...manifest,
        itemType: 'PullRequest',
        initialHeadSha: 'original-head',
      },
      pullRequest,
      checks,
      config,
      worktreeStatus: '',
      worktreeHeadSha: 'abc123',
    }).ready,
    false,
  );
});

test('squash merges a validated ready worker and marks its card Done', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'scale-reconcile-'));
  const workersDirectory = join(stateDirectory, 'workers');
  const boardPath = join(stateDirectory, 'board.json');
  const operationsPath = join(stateDirectory, 'operations.log');
  const manifestPath = join(workersDirectory, 'issue-999.json');
  const fakeGhPath = join(stateDirectory, 'fake-gh.mjs');
  const fakeGitPath = join(stateDirectory, 'fake-git.mjs');
  const configPath = join(stateDirectory, 'config.json');
  mkdirSync(workersDirectory);

  writeFileSync(
    boardPath,
    JSON.stringify({
      items: [
        {
          id: 'item-999',
          status: 'Autonomous',
          content: {
            type: 'Issue',
            number: 999,
            url: 'https://github.com/telekom/scale/issues/999',
          },
        },
      ],
    }),
  );
  writeFileSync(
    manifestPath,
    JSON.stringify({
      itemId: 'item-999',
      itemType: 'Issue',
      issueNumber: 999,
      worktree: stateDirectory,
      status: 'ready',
      attempt: 1,
      result: {
        prUrl: 'https://github.com/telekom/scale/pull/999',
        headSha: 'abc123',
      },
    }),
  );
  writeFileSync(
    fakeGhPath,
    `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const arguments_ = process.argv.slice(2);
const board = JSON.parse(readFileSync(process.env.BOARD_PATH, 'utf8'));
if (arguments_[0] === 'project' && arguments_[1] === 'item-list') {
  process.stdout.write(JSON.stringify(board));
} else if (arguments_[0] === 'project' && arguments_[1] === 'view') {
  process.stdout.write(JSON.stringify({ id: 'project-id' }));
} else if (arguments_[0] === 'project' && arguments_[1] === 'field-list') {
  process.stdout.write(JSON.stringify({ fields: [{
    id: 'status-id', name: 'Status', options: [
      { id: 'autonomous-id', name: 'Autonomous' },
      { id: 'done-id', name: 'Done' },
      { id: 'needs-owner-id', name: 'Needs owner' }
    ]
  }] }));
} else if (arguments_[0] === 'pr' && arguments_[1] === 'view') {
  process.stdout.write(JSON.stringify({
    headRefOid: 'abc123', baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE'
  }));
} else if (arguments_[0] === 'pr' && arguments_[1] === 'checks') {
  process.stdout.write(JSON.stringify(${JSON.stringify(requiredChecks)}.map((name) => ({ name, bucket: 'pass' }))));
} else if (arguments_[0] === 'pr' && arguments_[1] === 'merge') {
  appendFileSync(process.env.OPERATIONS_PATH, 'merge:' + arguments_.join(' ') + '\\n');
} else if (arguments_[0] === 'project' && arguments_[1] === 'item-edit') {
  board.items[0].status = 'Done';
  writeFileSync(process.env.BOARD_PATH, JSON.stringify(board));
  appendFileSync(process.env.OPERATIONS_PATH, 'status:Done\\n');
} else {
  process.stderr.write('Unexpected gh arguments: ' + JSON.stringify(arguments_));
  process.exit(1);
}
`,
  );
  writeFileSync(
    fakeGitPath,
    `const arguments_ = process.argv.slice(2);
if (arguments_[0] === 'status') {
  process.stdout.write('');
} else if (arguments_[0] === 'rev-parse') {
  process.stdout.write('abc123\\n');
} else {
  process.stderr.write('Unexpected git arguments: ' + JSON.stringify(arguments_));
  process.exit(1);
}
`,
  );
  writeFileSync(
    configPath,
    JSON.stringify({
      repositoryPath: stateDirectory,
      stateDirectory,
      worktreeRoot: join(stateDirectory, 'worktrees'),
      projectOwner: 'amir-ba',
      projectNumber: 1,
      repository: 'telekom/scale',
      maxWorkers: 5,
      maxTriage: 10,
      heartbeatStaleMs: 300000,
      maxAttempts: 3,
      requiredChecks,
      ghCommand: process.execPath,
      ghArguments: [fakeGhPath],
      gitCommand: process.execPath,
      gitArguments: [fakeGitPath],
    }),
  );

  execFileSync(process.execPath, [orchestratorPath, '--config', configPath], {
    encoding: 'utf8',
    env: { ...process.env, BOARD_PATH: boardPath, OPERATIONS_PATH: operationsPath },
  });

  const board = JSON.parse(readFileSync(boardPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const operations = readFileSync(operationsPath, 'utf8').trim().split('\n');
  assert.equal(board.items[0].status, 'Done');
  assert.equal(manifest.status, 'done');
  assert.match(operations[0], /^merge:pr merge .* --squash$/);
  assert.equal(operations[1], 'status:Done');
});