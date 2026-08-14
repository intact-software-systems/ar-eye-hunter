#!/usr/bin/env node

import {
  checkRepositoryStructure,
  resolveRepositoryStructureBase,
} from './repo-structure-check/repository-structure-check.mjs';

try {
  const input = readInput(process.argv.slice(2));
  const repoRoot = process.cwd();
  const base = input.base ?? resolveRepositoryStructureBase();
  const result = checkRepositoryStructure({ repoRoot, base });
  printResult(result);
  process.exitCode = 0;
} catch (error) {
  console.error(`repository structure check failed: ${toError(error).message}`);
  process.exitCode = 2;
}

function readInput(args) {
  const usage = 'usage: node scripts/repo-structure-check.mjs [--base <git-ref>]';
  if (args.length === 0) {
    return {};
  }
  if (args.length === 2 && args[0] === '--base' && args[1] !== '') {
    return { base: args[1] };
  }
  throw new Error(usage);
}

function printResult(result) {
  if (result.findings.length === 0) {
    console.log(`PASS: repository structure (${result.mergeBase} -> WORKTREE)`);
    return;
  }
  console.log(
    `REVIEW: repository structure has ${result.findings.length} finding` +
      `${result.findings.length === 1 ? '' : 's'} (${result.mergeBase} -> WORKTREE):`,
  );
  for (const finding of result.findings) {
    console.log(`${finding.target} [${finding.ruleId}]`);
    console.log(`  ${finding.message}`);
  }
  console.log(`PASS: repository structure (${result.mergeBase} -> WORKTREE)`);
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
