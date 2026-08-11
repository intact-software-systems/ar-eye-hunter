#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readReviewRecord } from './legacy-review/validate-supplied-evidence.mjs';

const options = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (index % 2 === 0 && value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const event = readJson(options.event);
const record = readReviewRecord(event.pull_request?.body ?? '');
if (record?.scope === 'exempt') {
  console.log('PASS: explicit PR-review exemption skips legacy candidate stage scans');
} else {
  const stages = [{ name: 'initial', kind: 'initial', review: record?.initialReview }];
  for (const [index, review] of (record?.milestoneReview?.entries ?? []).entries())
    stages.push({ name: `milestone-${index + 1}`, kind: 'milestone', review });
  if (!event.pull_request?.draft && record?.finalReview)
    stages.push({ name: 'final', kind: 'final', review: record.finalReview, final: true });
  for (const stage of stages) {
    runStage({
      stage,
      currentHead: options['current-head'],
      trustedBase: options['trusted-base'],
      registry: options.registry,
      retainedLegacy: record?.retainedLegacy,
    });
  }
  console.log(`PASS: validated ${stages.length} exact-SHA legacy candidate review stage(s)`);
}

function runStage({ stage, currentHead, trustedBase, registry, retainedLegacy }) {
  const base = stage.review?.mergeBaseSha;
  const head = stage.review?.headSha;
  if (!isSha(base) || !isSha(head)) fail(`${stage.name} review must contain exact SHAs`);
  for (const [sha, label] of [
    [base, 'merge base'],
    [head, 'head'],
  ])
    if (!git(['cat-file', '-e', `${sha}^{commit}`]))
      fail(`${stage.name} ${label} is not a fetched commit`);
  const actualBase = gitText(['merge-base', trustedBase, head]);
  if (actualBase !== base)
    fail(`${stage.name} recorded merge base does not match trusted PR base history`);
  if (stage.final ? head !== currentHead : !git(['merge-base', '--is-ancestor', head, currentHead]))
    fail(`${stage.name} review head is not reachable from current candidate head`);
  const temp = mkdtempSync(path.join(tmpdir(), 'legacy-stage-'));
  try {
    const review = path.join(temp, 'review.json');
    writeFileSync(review, JSON.stringify(stageReviewRecord({ stage, retainedLegacy })));
    const legacyReviewArguments = [
      'scripts/review-legacy.mjs',
      base,
      head,
      '--review-record',
      review,
      '--stage',
      stage.kind,
    ];
    if (stage.kind === 'final' && registry) {
      legacyReviewArguments.push('--registry', registry);
    }
    execFileSync(process.execPath, legacyReviewArguments, { stdio: 'inherit' });
  } catch {
    fail(`${stage.name} legacy ledger does not match its exact stage range`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function stageReviewRecord({ stage, retainedLegacy }) {
  const stageRecord = {
    scope: 'code-changing',
    retainedLegacy: stage.kind === 'final' && Array.isArray(retainedLegacy) ? retainedLegacy : [],
  };
  if (stage.kind === 'initial') {
    return { ...stageRecord, initialReview: stage.review };
  }
  if (stage.kind === 'milestone') {
    return {
      ...stageRecord,
      milestoneReview: { classification: 'reviewed', entries: [stage.review] },
    };
  }
  return { ...stageRecord, finalReview: stage.review };
}
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail('event must be readable JSON');
  }
}
function git(args) {
  try {
    execFileSync('git', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
function gitText(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    fail(`could not read Git evidence: git ${args.join(' ')}`);
  }
}
function isSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}
function fail(message) {
  console.log(`FAIL: ${message}`);
  process.exit(1);
}
