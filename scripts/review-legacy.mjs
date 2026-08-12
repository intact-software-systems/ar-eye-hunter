#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  readReviewRecord,
  validateSuppliedEvidence,
} from './legacy-review/validate-supplied-evidence.mjs';
import {
  computeReportSha256,
  printReport,
  toCanonicalReport,
  toCanonicalReportText,
} from './legacy-review/candidate-report.mjs';
import { scanChangedProduction } from './legacy-review/scan-changed-production.mjs';

const input = readInput(process.argv.slice(2));
const result = input.isExempt
  ? { ...input, changedFiles: [], candidates: [], exempt: true }
  : toDigestedScan(scanChangedProduction(input));

if (!input.isExempt && input.reportOut !== undefined) {
  writeFileSync(input.reportOut, toCanonicalReportText(toCanonicalReport(result)));
}
printReport(result);
const validationErrors = validateSuppliedEvidence(input, result.candidates);
if (validationErrors.length > 0) {
  for (const error of validationErrors) {
    console.log(`FAIL: ${error}`);
  }
  process.exitCode = 1;
} else if (input.reviewRecord) {
  console.log('PASS: supplied final review ledger disposes every reported candidate');
}

function toDigestedScan(scan) {
  const reportText = toCanonicalReportText(toCanonicalReport(scan));
  return { ...scan, reportSha256: computeReportSha256(reportText) };
}

function readInput(args) {
  const [baseReference, headReference, ...optionArgs] = args;
  if (!baseReference || !headReference) {
    failUsage(
      'usage: npm run review:legacy -- <base> <head> ' +
        '[--review-record file] [--registry file] [--stage stage] [--report-out file]',
    );
  }
  const options = readOptions(optionArgs);
  if (options.registry && !options['review-record']) {
    failUsage('--registry requires --review-record');
  }
  const base = resolveCommit(baseReference, 'base');
  const head = resolveCommit(headReference, 'head');
  const isExempt = readExemptScope(options['review-record']);
  return {
    base,
    head,
    mergeBase: runGit(['merge-base', base, head]).trim(),
    reviewRecord: options['review-record'],
    registry: options.registry,
    stage: options.stage,
    reportOut: options['report-out'],
    isExempt,
  };
}

function readExemptScope(reviewRecordPath) {
  if (!reviewRecordPath) return false;
  try {
    return readReviewRecord(readFileSync(reviewRecordPath, 'utf8'))?.scope === 'exempt';
  } catch {
    return false;
  }
}

function readOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option?.startsWith('--') || value === undefined) {
      failUsage('options must use --name value pairs');
    }
    const name = option.slice(2);
    const supportedOptions = ['review-record', 'registry', 'stage', 'report-out'];
    if (!supportedOptions.includes(name) || options[name] !== undefined) {
      failUsage(`unsupported or repeated option: ${option}`);
    }
    options[name] = value;
  }
  if (options.stage && !['initial', 'final'].includes(options.stage)) {
    failUsage('--stage must be initial or final');
  }
  return options;
}

function resolveCommit(reference, name) {
  const output = tryGit(['rev-parse', '--verify', `${reference}^{commit}`]);
  if (!output) {
    failUsage(`${name} reference does not resolve to a commit: ${reference}`);
  }
  return output.toString('utf8').trim();
}

function runGit(args) {
  return runGitBuffer(args).toString('utf8');
}

function runGitBuffer(args) {
  const output = tryGit(args);
  if (!output) {
    failUsage(`could not read Git evidence: git ${args.join(' ')}`);
  }
  return output;
}

function tryGit(args) {
  try {
    return execFileSync('git', args);
  } catch {
    return undefined;
  }
}

function failUsage(message) {
  console.log(`FAIL: ${message}`);
  process.exit(1);
}
