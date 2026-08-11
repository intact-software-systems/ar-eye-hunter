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
  const stages = [{ name: 'initial', review: record?.initialReview }];
  for (const [index, review] of (record?.milestoneReview?.entries ?? []).entries())
    stages.push({ name: `milestone-${index + 1}`, review });
  if (!event.pull_request?.draft && record?.finalReview)
    stages.push({ name: 'final', review: record.finalReview, final: true });
  for (const stage of stages) runStage(stage, options['current-head'], options.registry);
  console.log(`PASS: validated ${stages.length} exact-SHA legacy candidate review stage(s)`);
}

function runStage(stage, currentHead, registry) {
  const base = stage.review?.mergeBaseSha;
  const head = stage.review?.headSha;
  if (!isSha(base) || !isSha(head)) fail(`${stage.name} review must contain exact SHAs`);
  for (const [sha, label] of [
    [base, 'merge base'],
    [head, 'head'],
  ])
    if (!git(['cat-file', '-e', `${sha}^{commit}`]))
      fail(`${stage.name} ${label} is not a fetched commit`);
  if (!git(['merge-base', '--is-ancestor', base, head]))
    fail(`${stage.name} merge base is not an ancestor of stage head`);
  if (stage.final ? head !== currentHead : !git(['merge-base', '--is-ancestor', head, currentHead]))
    fail(`${stage.name} review head is not reachable from current candidate head`);
  const temp = mkdtempSync(path.join(tmpdir(), 'legacy-stage-'));
  try {
    const review = path.join(temp, 'review.json');
    writeFileSync(review, JSON.stringify({ scope: 'code-changing', finalReview: stage.review }));
    execFileSync(
      process.execPath,
      [
        'scripts/review-legacy.mjs',
        base,
        head,
        '--review-record',
        review,
        '--registry',
        registry,
        '--stage',
        'final',
      ],
      { stdio: 'inherit' },
    );
  } catch {
    fail(`${stage.name} legacy ledger does not match its exact stage range`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
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
function isSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}
function fail(message) {
  console.log(`FAIL: ${message}`);
  process.exit(1);
}
