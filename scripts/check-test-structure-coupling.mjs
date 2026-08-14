#!/usr/bin/env node

import {
  readCompleteCurrentCandidates,
  readRangeChanges,
  readReportCandidates,
  resolveCommit,
} from './test-structure-coupling-range-evidence.mjs';
import {
  printReport,
  readGovernedTestCouplingRegistry,
  readRegistry,
  validateRegistry,
} from './test-structure-coupling-registry-report.mjs';

const reviewInput = readReviewInput(process.argv.slice(2));
const report = readReportCandidates(reviewInput);
const completeCurrent = readCompleteCurrentCandidates(reviewInput);
const registry = readGovernedTestCouplingRegistry(reviewInput, readRegistry(reviewInput));
const registeredCandidateIds = new Set(
  registry.entries
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string')
    .map((entry) => entry.id),
);
const validationErrors = [
  ...new Set([
    ...report.errors,
    ...completeCurrent.errors,
    ...validateRegistry(registry, completeCurrent.candidates),
    ...changedClassificationErrors(reviewInput, report.candidates, registeredCandidateIds),
  ]),
].toSorted();

printReport({
  reviewInput,
  reportCandidates: report.candidates,
  reviewedPaths: report.reviewedPaths,
  registry,
  hasFailures: validationErrors.length > 0,
});
for (const error of validationErrors) {
  console.log(`FAIL: ${error}`);
}

function changedClassificationErrors(reviewInput, candidates, registeredCandidateIds) {
  if (reviewInput.mode !== 'changed-range') {
    return [];
  }
  return candidates
    .filter(
      (candidate) => candidate.change !== 'deleted' && !registeredCandidateIds.has(candidate.id),
    )
    .map(
      (candidate) =>
        `changed candidate lacks individual classification: ${candidate.id} ` +
        `${candidate.path}:${candidate.line}:${candidate.column}`,
    );
}
if (validationErrors.length > 0) {
  process.exitCode = 1;
} else {
  console.log('PASS: registry entries are complete and current');
}

function readReviewInput(args) {
  if (args.length === 0) {
    return { mode: 'full' };
  }
  if (args.length > 1 && args[0] === '--files') {
    return { mode: 'changed-files', paths: args.slice(1) };
  }
  if (args.length === 3 && args[0] === '--changed') {
    const base = resolveCommit(args[1], 'base');
    const head = resolveCommit(args[2], 'head');
    return { mode: 'changed-range', base, head, changes: readRangeChanges(base, head) };
  }
  failUsage(
    [
      'usage: npm run check:test-structure-coupling',
      '[--files <test-file>...] [--changed <base> <head>]',
    ].join(' '),
  );
}

function failUsage(message) {
  console.log(`FAIL: ${message}`);
  process.exit(1);
}
