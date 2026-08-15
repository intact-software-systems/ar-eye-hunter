#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { printReport } from './legacy-review/candidate-report.mjs';
import { readRetainedLegacyRegistry } from './legacy-review/retained-legacy-registry.mjs';
import { scanChangedProduction } from './legacy-review/scan-changed-production.mjs';

const input = readInput(process.argv.slice(2));
const result = scanChangedProduction(input);
printReport(result);
if (input.registry) {
  validateRegistry(input.registry);
}

function readInput(arguments_) {
  const [baseReference, headReference, ...optionArguments] = arguments_;
  if (!baseReference || !headReference) {
    fail('usage: npm run review:legacy -- <base> <head> [--registry file]');
  }
  const options = readOptions(optionArguments);
  const base = resolveCommit(baseReference, 'base');
  const head = resolveCommit(headReference, 'head');

  return {
    base,
    head,
    mergeBase: runGit(['merge-base', base, head]).trim(),
    registry: options.registry,
  };
}

function readOptions(arguments_) {
  if (arguments_.length === 0) {
    return {};
  }
  if (arguments_.length !== 2 || arguments_[0] !== '--registry') {
    fail('only --registry <file> is supported');
  }
  return { registry: arguments_[1] };
}

function resolveCommit(reference, name) {
  const output = tryGit(['rev-parse', '--verify', `${reference}^{commit}`]);
  if (!output) {
    fail(`${name} reference does not resolve to a commit: ${reference}`);
  }
  return output.trim();
}

function validateRegistry(registryPath) {
  let source;
  try {
    source = readFileSync(registryPath, 'utf8');
  } catch {
    fail(`retained production legacy registry is not readable: ${registryPath}`);
  }

  const registry = readRetainedLegacyRegistry(source);
  if (registry.issues.length > 0) {
    for (const issue of registry.issues) {
      console.log(`FAIL: ${issue}`);
    }
    process.exit(1);
  }
  console.log('PASS: retained production legacy registry is valid');
}

function runGit(arguments_) {
  const output = tryGit(arguments_);
  if (output === undefined) {
    fail(`could not read Git state: git ${arguments_.join(' ')}`);
  }
  return output;
}

function tryGit(arguments_) {
  try {
    return execFileSync('git', arguments_, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

function fail(message) {
  console.log(`FAIL: ${message}`);
  process.exit(1);
}
