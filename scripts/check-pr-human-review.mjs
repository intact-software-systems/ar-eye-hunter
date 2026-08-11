import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { isExactSha, validateReviewRecord } from './pr-human-review/validate-record.mjs';

const input = readValidatorInput(process.argv.slice(2));
const errors = validateReviewRecord(input);

if (errors.length > 0) {
  for (const error of errors) {
    console.log(`FAIL: ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log('PASS: PR human review record evidence is current and complete');
}

function readValidatorInput(args) {
  const options = readOptions(args);
  if (options.event) {
    return readGitHubEventInput(options);
  }
  const required = ['body', 'changed-paths', 'registry', 'reviews', 'merge-base', 'head', 'draft'];
  const missing = required.filter((name) => options[name] === undefined);
  if (missing.length > 0) {
    failInput(`missing required options: ${missing.join(', ')}`);
  }
  return {
    body: readFileSync(options.body, 'utf8'),
    changedPaths: readLines(options['changed-paths']),
    registry: readFileSync(options.registry, 'utf8'),
    trustedReviews: readTrustedReviews(options.reviews),
    mergeBaseSha: options['merge-base'],
    headSha: options.head,
    draft: parseBoolean(options.draft),
    pathsAfterApproval: readJsonOrEmpty(options['paths-after-approval']),
  };
}

function readGitHubEventInput(options) {
  const event = readJson(options.event);
  const pullRequest = event.pull_request;
  if (!isRecord(pullRequest) || typeof pullRequest.body !== 'string') {
    failInput('GitHub event does not contain pull_request data');
  }
  const baseTipSha = pullRequest.base?.sha;
  const headSha = pullRequest.head?.sha;
  if (!isExactSha(baseTipSha) || !isExactSha(headSha) || typeof pullRequest.draft !== 'boolean') {
    failInput('GitHub event must provide exact base, head, and draft data');
  }
  const mergeBaseSha = runGit(['merge-base', baseTipSha, headSha]);
  const changedPaths = runGit(['diff', '--name-only', `${mergeBaseSha}...${headSha}`])
    .split('\n')
    .filter(Boolean);
  const approvalShas = readApprovalShas(pullRequest.body);
  const pathsAfterApproval = Object.fromEntries(
    approvalShas.map((approvedProductionSha) => [
      approvedProductionSha,
      runGit(['diff', '--name-only', `${approvedProductionSha}...${headSha}`])
        .split('\n')
        .filter(Boolean),
    ]),
  );
  return {
    body: pullRequest.body,
    changedPaths,
    registry: readFileSync(options.registry ?? 'docs/production-legacy-exceptions.md', 'utf8'),
    trustedReviews: readTrustedReviews(options.reviews),
    mergeBaseSha,
    headSha,
    draft: pullRequest.draft,
    pathsAfterApproval,
  };
}

function readApprovalShas(body) {
  const match = body.match(/```pr-human-review-record-v1\s*\n([\s\S]*?)\n```/u);
  if (!match) {
    return [];
  }
  try {
    const record = JSON.parse(match[1]);
    return Array.isArray(record?.retainedLegacy)
      ? record.retainedLegacy.map((item) => item?.approvedProductionSha).filter(isExactSha)
      : [];
  } catch {
    return [];
  }
}

function readOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option?.startsWith('--') || value === undefined) {
      failInput('expected --name value options');
    }
    const name = option.slice(2);
    if (options[name] !== undefined) {
      failInput(`option --${name} was supplied more than once`);
    }
    options[name] = value;
  }
  return options;
}

function readLines(filePath) {
  return readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readJsonOrEmpty(filePath) {
  return filePath === undefined ? {} : readJson(filePath);
}

function readTrustedReviews(filePath) {
  const reviews = readJson(filePath);
  if (!Array.isArray(reviews)) {
    failInput('trusted GitHub reviews must be an array');
  }
  // `gh api --paginate --slurp` yields an array of response pages. Direct
  // fixture and local callers may provide the equivalent flat review array.
  const flattened = reviews.flat();
  if (!flattened.every(isRecord)) {
    failInput('trusted GitHub reviews must contain only review objects');
  }
  return flattened;
}

function runGit(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    failInput(`could not read Git evidence: git ${args.join(' ')}`);
  }
}

function parseBoolean(value) {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  failInput('--draft must be true or false');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failInput(message) {
  console.log(`FAIL: ${message}`);
  process.exit(2);
}
