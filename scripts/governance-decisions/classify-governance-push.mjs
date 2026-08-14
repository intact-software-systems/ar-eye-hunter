#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

import {
  classifyGovernancePushCandidate,
  resolveGovernancePushClassification,
} from './governance-decision-push-classification.mjs';

try {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === 'candidate') {
    classifyCandidate(parseOptions(arguments_));
  } else if (command === 'resolve') {
    resolveClassification(parseOptions(arguments_));
  } else {
    throw new Error('expected candidate or resolve');
  }
} catch (error) {
  process.stderr.write(`${toError(error).message}\n`);
  process.exitCode = 1;
}

function classifyCandidate(options) {
  const commitOid = requireOption(options, 'commit');
  const outputPath = requireOption(options, 'output');
  if (!/^[0-9a-f]{40}$/u.test(commitOid)) {
    throw new Error('--commit must be a full lowercase Git object ID');
  }
  const subject = runGit(['show', '-s', '--format=%s', commitOid]).trimEnd();
  const changedPaths = runGit([
    'diff-tree',
    '--root',
    '--no-commit-id',
    '--name-only',
    '-r',
    commitOid,
  ])
    .split('\n')
    .filter(Boolean);
  const result = classifyGovernancePushCandidate({ subject, changedPaths });
  appendFileSync(outputPath, `governance_candidate=${result.governanceCandidate}\n`);
}

function resolveClassification(options) {
  const result = resolveGovernancePushClassification({
    eventName: requireOption(options, 'event-name'),
    candidateOutcome: requireOption(options, 'candidate-outcome'),
    governanceCandidate: requireOption(options, 'candidate') === 'true',
    verificationOutcome: requireOption(options, 'verification-outcome'),
  });
  appendFileSync(
    requireOption(options, 'output'),
    `decision_only=${result.decisionOnly}\ninvalid_governance=${result.invalidGovernance}\n`,
  );
}

function parseOptions(arguments_) {
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (!option?.startsWith('--') || value === undefined || options.has(option.slice(2))) {
      throw new Error('classification options must be unique --name value pairs');
    }
    options.set(option.slice(2), value);
  }
  return options;
}

function requireOption(options, name) {
  const value = options.get(name);
  if (typeof value !== 'string' || value === '') {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function runGit(arguments_) {
  return execFileSync('git', arguments_, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
