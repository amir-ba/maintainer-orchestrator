/*
 * Scale https://github.com/telekom/scale
 *
 * Copyright (c) 2021 Egor Kirpichev and contributors, Deutsche Telekom AG
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

function parseJsonResponse(output) {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`No JSON object found in output: ${output.slice(0, 200)}`);
  }
  const raw = output.slice(start, end + 1);
  try {
    return JSON.parse(raw);
  } catch {
    // Escape bare control characters inside JSON string literals that the CLI emits unescaped
    const sanitized = raw.replace(/"(?:[^"\\]|\\.)*"/gs, (match) =>
      match.replace(/[\x00-\x1F]/g, (c) =>
        ({ '\n': '\\n', '\r': '\\r', '\t': '\\t' }[c] ??
          `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
      )
    );
    return JSON.parse(sanitized);
  }
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

export function validateTriage(result) {
  if (typeof result?.eligible !== 'boolean') {
    throw new Error('Triage result requires an eligible boolean');
  }
  const normalized = {
    ...result,
    locks: normalizeStringArray(result.locks, normalizeLock),
    verification: normalizeStringArray(
      result.verification,
      normalizeVerificationCommand,
    ),
  };
  if (
    !Array.isArray(result.locks) ||
    !result.locks.every((lock) => typeof lock === 'string') ||
    !Array.isArray(result.verification) ||
    !result.verification.every((check) => typeof check === 'string')
  ) {
    throw new Error('Triage locks and verification must be string arrays');
  }
  if (
    normalized.eligible &&
    (normalized.locks.length === 0 ||
      normalized.verification.length === 0 ||
      !normalized.rationale)
  ) {
    throw new Error('Eligible triage requires locks, verification, and rationale');
  }
  if (!normalized.eligible && (!normalized.blocker || !normalized.decisionBrief)) {
    throw new Error('Ineligible triage requires blocker and decisionBrief');
  }
  return normalized;
}

function runCopilot({ command, prefixArguments, repository, prompt, model, maxAiCredits }) {
  return spawnSync(
    command,
    [
      ...prefixArguments,
      '-p',
      prompt,
      '-C',
      repository,
      '--model',
      model,
      '--max-ai-credits',
      String(maxAiCredits),
      '--no-ask-user',
      '--silent',
      '--stream',
      'off',
      '--disable-builtin-mcps',
      '--available-tools=view,grep,glob,skill',
      '--allow-tool=read',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
}

export function createTriagePrompt(item, { projectOwner, projectNumber }) {
  return `Invoke these skills in order: \`scale-maintainer\`, \`github-project-triage\`, and \`github-deep-review\`.
For every invoked skill, the configured GitHub Project is owner \`${projectOwner}\`, number \`${projectNumber}\`.
Triage the attached telekom/scale Project item for autonomous processing. Follow the skills' read-only triage instructions only: do not edit files, execute commands, or mutate GitHub. Use the attached item as the available GitHub evidence.
During read-only triage, missing executed checks alone does not make a PR ineligible. Eligibility requires a concrete verification plan; the isolated worker executes it.


Return only one JSON object matching one of these forms:
{"eligible":true,"locks":["component:name"],"verification":["specific test or command"],"rationale":"concise reason"}
{"eligible":false,"locks":[],"verification":[],"blocker":"concise blocker","decisionBrief":"decision-ready GitHub comment"}

Project item JSON:
${JSON.stringify(item)}`;
}

export function triageItem({
  item,
  repository,
  projectOwner,
  projectNumber,
  copilotCommand = 'copilot',
  copilotArguments = [],
  model,
  fallbackModel,
  maxAiCredits = 30,
}) {
  const prompt = createTriagePrompt(item, { projectOwner, projectNumber });
  const models = model === fallbackModel ? [model] : [model, fallbackModel];

  for (const candidateModel of models) {
    const result = runCopilot({
      command: copilotCommand,
      prefixArguments: copilotArguments,
      repository,
      prompt,
      model: candidateModel,
      maxAiCredits,
    });
    if (result.status === 0) {
      return validateTriage(parseJsonResponse(result.stdout));
    }
    const unavailable = /Model .* is not available/i.test(result.stderr);
    if (!unavailable || candidateModel === models.at(-1)) {
      throw new Error(result.stderr || 'Copilot triage failed');
    }
  }

  throw new Error('Copilot triage did not produce a result');
}

function main() {
  const { values } = parseArgs({
    options: {
      item: { type: 'string' },
      repository: { type: 'string' },
      'project-owner': { type: 'string' },
      'project-number': { type: 'string' },
      'copilot-command': { type: 'string', default: 'copilot' },
      'copilot-arg': { type: 'string', multiple: true, default: [] },
      model: { type: 'string' },
      'fallback-model': { type: 'string', default: 'auto' },
      'max-ai-credits': { type: 'string', default: '30' },
      json: { type: 'boolean', default: false },
    },
  });
  if (
    !values.item ||
    !values.repository ||
    !values['project-owner'] ||
    !values['project-number'] ||
    !values.model
  ) {
    throw new Error(
      '--item, --repository, --project-owner, --project-number, and --model are required',
    );
  }

  const result = triageItem({
    item: JSON.parse(readFileSync(values.item, 'utf8')),
    repository: values.repository,
    projectOwner: values['project-owner'],
    projectNumber: values['project-number'],
    copilotCommand: values['copilot-command'],
    copilotArguments: values['copilot-arg'],
    model: values.model,
    fallbackModel: values['fallback-model'],
    maxAiCredits: Number.parseInt(values['max-ai-credits'], 10),
  });
  process.stdout.write(`${JSON.stringify(result, null, values.json ? 0 : 2)}\n`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main();
}