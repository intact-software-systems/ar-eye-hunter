#!/usr/bin/env node

import {
  checkRepositoryStructure,
  resolveRepositoryStructureBase,
} from './repo-structure-check/repository-structure-check.mjs';

try {
  const input = readInput(process.argv.slice(2));
  const repoRoot = process.cwd();
  const base = input.base ?? resolveRepositoryStructureBase(repoRoot);
  const result = checkRepositoryStructure({ repoRoot, base });
  printResult(result);
  process.exitCode = result.findings.length === 0 ? 0 : 1;
} catch (error) {
  console.error(`repository structure check failed: ${toError(error).message}`);
  process.exitCode = 2;
}

function readInput(args) {
  const input = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error('usage: node scripts/repo-structure-check.mjs [--base <git-ref>]');
    }
    if (option === '--base' && input.base === undefined) {
      input.base = value;
    } else {
      throw new Error('usage: node scripts/repo-structure-check.mjs [--base <git-ref>]');
    }
  }
  return input;
}

function printResult(result) {
  if (result.findings.length === 0) {
    console.log(`PASS: repository structure (${result.mergeBase} -> WORKTREE)`);
    return;
  }
  console.log(
    `FAIL: ${result.findings.length} repository structure finding` +
      `${result.findings.length === 1 ? '' : 's'} (${result.mergeBase} -> WORKTREE):`,
  );
  for (const finding of result.findings) {
    console.log(`${finding.target} [${finding.ruleId}]`);
    console.log(`  ${finding.message}`);
  }
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
