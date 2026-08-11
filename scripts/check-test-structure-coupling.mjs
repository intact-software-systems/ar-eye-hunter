#!/usr/bin/env node

import {
  readCompleteCurrentCandidates,
  readRangeChanges,
  readReportCandidates,
  resolveCommit,
} from './test-structure-coupling-range-evidence.mjs';
import {
  printReport,
  readRegistry,
  validateRegistry,
} from './test-structure-coupling-registry-report.mjs';

const reviewInput = readReviewInput(process.argv.slice(2));
const report = readReportCandidates(reviewInput);
const completeCurrent = readCompleteCurrentCandidates(reviewInput);
const registry = readRegistry(reviewInput);
const validationErrors = [
  ...new Set([
    ...report.errors,
    ...completeCurrent.errors,
    ...validateRegistry(registry, completeCurrent.candidates),
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
