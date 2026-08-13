#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  readOriginMainGovernanceDecisionIndex,
  resolveGovernanceGateDeviations,
} from './governance-decisions/governance-decision-receipt-index.mjs';
import { resolveGovernanceGateStatus } from './governance-gate/governance-gate-resolution.mjs';

try {
  const options = readOptions(process.argv.slice(2));
  const repoRoot = path.resolve(requiredOption(options, '--repo-root'));
  const localStatus = requiredOption(options, '--local-status');
  const candidateSha = requiredOption(options, '--candidate');
  const gateName = requiredOption(options, '--gate-name');
  let deviations = 'not-read';
  if (localStatus === 'failed') {
    const index = readOriginMainGovernanceDecisionIndex(repoRoot);
    if (index.issues.length > 0) {
      throw new Error(`trusted governance receipt index: ${index.issues.join('; ')}`);
    }
    deviations = resolveGovernanceGateDeviations(index, { candidateSha, gateName });
  }
  const result = resolveGovernanceGateStatus({
    localStatus,
    candidateSha,
    currentRunId: readPositiveInteger(options, '--current-run-id'),
    currentRunAttempt: readPositiveInteger(options, '--current-run-attempt'),
    gateName,
    deviations,
  });
  writeFileSync(
    requiredOption(options, '--output'),
    [
      `status=${result.status}`,
      `underlying_status=${result.underlyingStatus}`,
      `decision_id=${result.decisionId}`,
    ].join('\n') + '\n',
    'utf8',
  );
  if (result.status === 'accepted-deviation') {
    console.log(
      `ACCEPTED DEVIATION: underlying governance gate failed; decision ${result.decisionId}`,
    );
  } else {
    console.log('PASS: governance gate passed');
  }
} catch (error) {
  console.error(`FAIL: governance gate resolution: ${toError(error).message}`);
  process.exitCode = 1;
}

function readOptions(args) {
  if (args.length % 2 !== 0) {
    throw new Error('every option must have one value');
  }
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!name.startsWith('--') || options.has(name) || args[index + 1] === '') {
      throw new Error(`invalid option: ${name}`);
    }
    options.set(name, args[index + 1]);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (value === undefined) {
    throw new Error(`missing required option: ${name}`);
  }
  return value;
}

function readPositiveInteger(options, name) {
  const value = Number(requiredOption(options, name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
