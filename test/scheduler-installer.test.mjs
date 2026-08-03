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
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const installerPath = resolve(testDirectory, '..', 'install-scheduler.ps1');
const repositoryPath = resolve(testDirectory, '..', '..', 'scale');

test('WhatIf describes a disabled non-overlapping 15-minute task', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'scale-scheduler-'));
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      installerPath,
      '-RepositoryPath',
      repositoryPath,
      '-StateDirectory',
      stateDirectory,
      '-HttpProxy',
      'http://proxy.example:8080',
      '-WhatIf',
      '-PassThru',
    ],
    { encoding: 'utf8' },
  );
  const definition = JSON.parse(
    output
      .trim()
      .split(/\r?\n/)
      .findLast((line) => line.startsWith('{')),
  );

  assert.equal(definition.taskName, 'Scale Maintainer Watch');
  assert.equal(definition.enabled, false);
  assert.equal(definition.intervalMinutes, 15);
  assert.equal(definition.multipleInstances, 'IgnoreNew');
  assert.equal(definition.logonType, 'InteractiveToken');
  assert.match(definition.arguments, /node\.exe/i);
  assert.match(definition.arguments, /--config/);
  assert.match(definition.arguments, /scheduler\.log/i);
  assert.match(definition.arguments, /set "http_proxy=http:\/\/proxy\.example:8080"/i);
  assert.match(definition.arguments, /set "https_proxy=http:\/\/proxy\.example:8080"/i);
  assert.match(definition.executable, /cmd\.exe$/i);
  assert.equal(definition.workingDirectory, resolve(testDirectory, '..'));

  const installer = readFileSync(installerPath, 'utf8');
  assert.match(installer, /httpProxy = \$HttpProxy/);
  assert.match(installer, /deniedShellCommands = @\(/);
  assert.match(installer, /'git push --force'/);
  assert.match(installer, /'yarn prepare-neutral'/);
});