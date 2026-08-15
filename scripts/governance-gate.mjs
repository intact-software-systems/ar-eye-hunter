#!/usr/bin/env node

import path from 'node:path';

import { GovernanceGateConfigurationError } from './governance-gate/governance-gate-phases.mjs';
import { runGovernanceGate } from './governance-gate/run-governance-gate.mjs';

await runGovernanceGateCommand(process.argv.slice(2));

export async function runGovernanceGateCommand(args) {
  try {
    const repoRoot = readRepoRoot(args);
    const results = await runGovernanceGate(repoRoot);
    printResults(results);
    process.exitCode = results.some((result) => result.status !== 0) ? 1 : 0;
  } catch (error) {
    const message = toError(error).message;
    const category = error instanceof GovernanceGateConfigurationError ? ' configuration' : '';
    console.error(`FAIL: governance gate${category}: ${message}`);
    process.exitCode = 1;
  }
}

function readRepoRoot(args) {
  if (args.length === 0) {
    return process.cwd();
  }
  if (args.length === 2 && args[0] === '--repo-root' && args[1] !== '') {
    return path.resolve(args[1]);
  }
  throw new GovernanceGateConfigurationError(
    'usage: node scripts/governance-gate.mjs [--repo-root <repository-path>]',
  );
}

function printResults(results) {
  const failures = results.filter((result) => result.status !== 0);
  if (failures.length > 0) {
    for (const result of results) {
      if (result.status === 0 && result.output !== '') {
        console.log(result.output);
      }
    }
    for (const failure of failures) {
      console.error(`FAIL: governance gate ${failure.phase} (${failure.command})`);
      if (failure.output !== '') {
        console.error(failure.output);
      }
    }
    return;
  }
  for (const result of results) {
    if (result.output !== '') {
      console.log(result.output);
    }
    console.log(`PASS: governance gate ${result.phase}`);
  }
  console.log(`PASS: governance gate (${results.length} phases)`);
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
