#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  readGithubValidationEvidenceArtifact,
  readGithubWorkflowJobs,
  readGithubWorkflowRuns,
} from './validation-evidence/github-validation-evidence.mjs';
import { validateBranchReleaseConclusion } from './validation-evidence/branch-release-result.mjs';
import { createValidationEvidence } from './validation-evidence/validation-evidence-record.mjs';
import {
  readWorkflowJobsEnvelope,
  readWorkflowRunsEnvelope,
  selectReusableValidationEvidence,
} from './validation-evidence/validation-evidence-selection.mjs';

await runValidationEvidenceCommand(process.argv.slice(2));

export async function runValidationEvidenceCommand(args) {
  try {
    const command = args.shift();
    if (!['conclude', 'create', 'select'].includes(command)) {
      throw new Error('usage: validation-evidence <conclude|create|select> <options>');
    }
    const options = readOptions(args);
    if (command === 'conclude') {
      runConclusion(options);
      return;
    }
    if (command === 'select') {
      runSelection(options);
      return;
    }
    runCreate(options);
  } catch (error) {
    console.error(`FAIL: validation evidence: ${toError(error).message}`);
    process.exitCode = 1;
  }
}

function runCreate(options) {
  const evidence = createValidationEvidence({
    repoRoot: path.resolve(requiredOption(options, '--repo-root')),
    run: JSON.parse(readFileSync(requiredOption(options, '--run-envelope'), 'utf8')),
    jobs: readWorkflowJobsEnvelope(
      readFileSync(requiredOption(options, '--jobs-envelope'), 'utf8'),
    ),
    releaseGateResult: requiredOption(options, '--release-gate-result'),
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
      workflowPath,
      branch,
      head: requiredOption(options, '--head'),
      currentRunId: Number(requiredOption(options, '--current-run-id')),
    },
    runs: sources.runs,
    readArtifact: sources.readArtifact,
    readJobs: sources.readJobs,
    now: requiredOption(options, '--now'),
  });
  const outputPath = requiredOption(options, '--output');
  const lines = [
    `reuse=${String(result.reuse)}`,
    `reason=${result.reason}`,
    `build_tree_digest=${result.buildTreeDigest}`,
  ];
  if (result.evidence !== undefined) {
    lines.push(`evidence_head=${result.evidence.head}`);
  }
  writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`PASS: validation evidence selection ${result.reason}`);
}

function readSelectionSources(options, githubIdentity) {
  const runsEnvelope = options.get('--runs-envelope');
  const artifactRoot = options.get('--artifact-root');
  const jobsRoot = options.get('--jobs-root');
  if (runsEnvelope !== undefined || artifactRoot !== undefined || jobsRoot !== undefined) {
    if (runsEnvelope === undefined || artifactRoot === undefined || jobsRoot === undefined) {
      throw new Error(
        'injected runs envelope, artifact root, and jobs root must be provided together',
      );
    }
    return {
      runs: readWorkflowRunsEnvelope(readFileSync(runsEnvelope, 'utf8')),
      readArtifact: (run) => readArtifact(artifactRoot, run.id),
      readJobs: (run) => readJobs(jobsRoot, run.id),
    };
  }
  return {
    runs: readGithubWorkflowRuns(githubIdentity),
    readArtifact: (run) =>
      readGithubValidationEvidenceArtifact({
        repository: githubIdentity.repository,
        runId: run.id,
      }),
    readJobs: (run) =>
      readGithubWorkflowJobs({
        repository: githubIdentity.repository,
        runId: run.id,
      }),
  };
}

function readArtifact(artifactRoot, runId) {
  try {
    return readFileSync(
      path.join(artifactRoot, String(runId), 'validation-evidence-v1.json'),
      'utf8',
    );
  } catch {
    return undefined;
  }
}

function readJobs(jobsRoot, runId) {
  try {
    return readWorkflowJobsEnvelope(
      readFileSync(path.join(jobsRoot, String(runId), 'jobs.json'), 'utf8'),
    );
  } catch {
    return undefined;
  }
}

function runConclusion(options) {
  const issues = validateBranchReleaseConclusion({
    governanceResult: requiredOption(options, '--governance-result'),
    governanceStatus: requiredOption(options, '--governance-status'),
    governanceUnderlyingStatus: requiredOption(options, '--governance-underlying-status'),
    governanceDecisionId: options.get('--governance-decision-id') ?? '',
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

function readOptions(args) {
  if (args.length % 2 !== 0) {
    throw new Error('every option must have one value');
  }
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (
      !name.startsWith('--') ||
      options.has(name) ||
      (args[index + 1] === '' && name !== '--governance-decision-id')
    ) {
      throw new Error(`invalid option: ${name}`);
    }
    options.set(name, args[index + 1]);
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
