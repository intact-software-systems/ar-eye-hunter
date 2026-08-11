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
    return readGitHubEventInput(options.event, options.registry);
  }

  const requiredOptions = ['body', 'changed-paths', 'registry', 'base', 'head', 'draft'];
  const missingOptions = requiredOptions.filter((name) => options[name] === undefined);

  if (missingOptions.length > 0) {
    failInput(`missing required options: ${missingOptions.join(', ')}`);
  }

  return {
    body: readFileSync(options.body, 'utf8'),
    changedPaths: readLines(options['changed-paths']),
    registry: readFileSync(options.registry, 'utf8'),
    baseSha: options.base,
    headSha: options.head,
    draft: parseBoolean(options.draft),
  };
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

function readGitHubEventInput(eventPath, registryPath = 'docs/production-legacy-exceptions.md') {
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const pullRequest = event.pull_request;

  if (!isRecord(pullRequest)) {
    failInput('GitHub event does not contain pull_request data');
  }

  const baseSha = pullRequest.base?.sha;
  const headSha = pullRequest.head?.sha;

  if (typeof pullRequest.body !== 'string' || typeof pullRequest.draft !== 'boolean') {
    failInput('GitHub pull_request event is missing body or draft state');
  }

  return {
    body: pullRequest.body,
    changedPaths: readChangedPathsFromGit(baseSha, headSha),
    registry: readFileSync(registryPath, 'utf8'),
    baseSha,
    headSha,
    draft: pullRequest.draft,
  };
}

function readChangedPathsFromGit(baseSha, headSha) {
  if (!isExactSha(baseSha) || !isExactSha(headSha)) {
    failInput('GitHub event must provide exact base and head SHAs');
  }

  try {
    const output = execFileSync('git', ['diff', '--name-only', `${baseSha}...${headSha}`], {
      encoding: 'utf8',
    });
    return output.split('\n').filter(Boolean);
  } catch {
    failInput('could not read changed paths for the event base and head SHAs');
  }
}

function readLines(filePath) {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean);
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
