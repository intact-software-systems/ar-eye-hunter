#!/usr/bin/env node

import {
  checkRepositoryStructure,
  readRepositoryNavigationEvidence,
  resolveRepositoryStructureBase,
} from './repo-structure-check/repository-structure-check.mjs';

try {
  const input = readInput(process.argv.slice(2));
  const repoRoot = process.cwd();
  if (input.navigationEvidenceOwner !== undefined) {
    const evidence = readRepositoryNavigationEvidence({
      repoRoot,
      owner: input.navigationEvidenceOwner,
      planPath: input.planPath,
    });
    console.log(JSON.stringify(evidence));
    process.exitCode = 0;
  } else {
    const base = input.base ?? resolveRepositoryStructureBase(repoRoot);
    const result = checkRepositoryStructure({ repoRoot, base });
    printResult(result);
    process.exitCode = result.findings.length === 0 ? 0 : 1;
  }
} catch (error) {
  console.error(`repository structure check failed: ${toError(error).message}`);
  process.exitCode = 2;
}

function readInput(args) {
  const usage =
    'usage: node scripts/repo-structure-check.mjs ' +
    '[--base <git-ref> | --navigation-evidence <capability-owner> [--plan <plans/file.md>]]';
  if (args.length === 0) {
    return {};
  }
  if (args.length === 2 && args[0] === '--base' && args[1] !== '') {
    return { base: args[1] };
  }
  if (
    (args.length === 2 || args.length === 4) &&
    args[0] === '--navigation-evidence' &&
    args[1] !== '' &&
    (args.length === 2 || (args[2] === '--plan' && args[3] !== ''))
  ) {
    return { navigationEvidenceOwner: args[1], planPath: args[3] };
  }
  throw new Error(usage);
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
