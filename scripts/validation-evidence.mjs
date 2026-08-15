#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  readGithubValidationEvidenceArtifact,
  readGithubWorkflowRuns,
} from './validation-evidence/github-validation-evidence.mjs';
import { validateBranchReleaseConclusion } from './validation-evidence/branch-release-result.mjs';
import { createValidationEvidence } from './validation-evidence/validation-evidence-record.mjs';
import {
  readWorkflowRunsEnvelope,
  selectReusableValidationEvidence,
} from './validation-evidence/validation-evidence-selection.mjs';

await runValidationEvidenceCommand(process.argv.slice(2));

export async function runValidationEvidenceCommand(arguments_) {
  try {
    const [command, ...optionArguments] = arguments_;
    if (!['conclude', 'create', 'select'].includes(command)) {
      throw new Error('usage: validation-evidence <conclude|create|select> <options>');
    }
    const options = readOptions(optionArguments);
    if (command === 'conclude') {
      runConclusion(options);
    } else if (command === 'create') {
      runCreate(options);
    } else {
      runSelection(options);
    }
  } catch (error) {
    console.error(`FAIL: validation evidence: ${toError(error).message}`);
    process.exitCode = 1;
  }
}

function runCreate(options) {
  const evidence = createValidationEvidence({
    repoRoot: path.resolve(requiredOption(options, '--repo-root')),
    context: {
      repository: requiredOption(options, '--repository'),
      pullRequestNumber: Number(requiredOption(options, '--pull-request-number')),
      workflowPath: requiredOption(options, '--workflow-path'),
      runId: Number(requiredOption(options, '--run-id')),
      runAttempt: Number(requiredOption(options, '--run-attempt')),
      head: requiredOption(options, '--head'),
      completedAt: requiredOption(options, '--completed-at'),
    },
  });
  const outputPath = requiredOption(options, '--output');
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`PASS: validation evidence written to ${outputPath}`);
}

function runSelection(options) {
  const repository = requiredOption(options, '--repository');
  const workflowPath = requiredOption(options, '--workflow-path');
  const branch = requiredOption(options, '--branch');
  const sources = readSelectionSources(options, { repository, workflowPath, branch });
  const result = selectReusableValidationEvidence({
    repoRoot: path.resolve(requiredOption(options, '--repo-root')),
    candidate: {
      repository,
      pullRequestNumber: Number(requiredOption(options, '--pull-request-number')),
      workflowPath,
      branch,
      baseBranch: requiredOption(options, '--base-branch'),
      head: requiredOption(options, '--head'),
      currentRunId: Number(requiredOption(options, '--current-run-id')),
    },
    runs: sources.runs,
    readArtifact: sources.readArtifact,
    now: requiredOption(options, '--now'),
  });
  const lines = [
    `reuse=${String(result.reuse)}`,
    `reason=${result.reason}`,
    `build_tree_digest=${result.buildTreeDigest}`,
  ];
  writeFileSync(requiredOption(options, '--output'), `${lines.join('\n')}\n`, 'utf8');
  console.log(`PASS: validation evidence selection ${result.reason}`);
}

function readSelectionSources(options, githubIdentity) {
  const runsEnvelope = options.get('--runs-envelope');
  const artifactRoot = options.get('--artifact-root');
  if (runsEnvelope !== undefined || artifactRoot !== undefined) {
    if (runsEnvelope === undefined || artifactRoot === undefined) {
      throw new Error('injected runs envelope and artifact root must be provided together');
    }
    return {
      runs: readWorkflowRunsEnvelope(readFileSync(runsEnvelope, 'utf8')),
      readArtifact: (run) => readArtifact(artifactRoot, run.id),
    };
  }
  return {
    runs: readGithubWorkflowRuns(githubIdentity),
    readArtifact: (run) =>
      readGithubValidationEvidenceArtifact({
        repository: githubIdentity.repository,
        runId: run.id,
      }),
  };
}

function readArtifact(artifactRoot, runId) {
  try {
    return readFileSync(
      path.join(artifactRoot, String(runId), 'validation-evidence-v2.json'),
      'utf8',
    );
  } catch {
    return undefined;
  }
}

function runConclusion(options) {
  const issues = validateBranchReleaseConclusion({
    governanceResult: requiredOption(options, '--governance-result'),
    selectionResult: requiredOption(options, '--selection-result'),
    reuse: requiredOption(options, '--reuse'),
    releaseResult: requiredOption(options, '--release-result'),
    publicationResult: requiredOption(options, '--publication-result'),
  });
  if (issues.length > 0) {
    throw new Error(issues.join('; '));
  }
  console.log('PASS: Branch Release Gate result');
}

function readOptions(arguments_) {
  if (arguments_.length % 2 !== 0) {
    throw new Error('every option must have one value');
  }
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name.startsWith('--') || value === '' || options.has(name)) {
      throw new Error(`invalid option: ${name}`);
    }
    options.set(name, value);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (value === undefined) {
    throw new Error(`missing required option: ${name}`);
  }
  return value;
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
