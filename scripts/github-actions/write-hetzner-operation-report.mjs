#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const argumentNames = [
  'log',
  'output-dir',
  'status',
  'phase',
  'exit-code',
  'commit',
  'manifest',
  'control-run-id',
  'distributed-run-id',
  'artifact-available',
  'started-at',
  'finished-at',
];

function readArguments(values) {
  const argumentsByName = new Map();

  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]?.replace(/^--/, '');
    const value = values[index + 1];
    if (!name || value === undefined) {
      throw new Error(`Expected --name value arguments; received ${values.join(' ')}`);
    }
    argumentsByName.set(name, value);
  }

  for (const name of argumentNames) {
    if (!argumentsByName.has(name)) {
      throw new Error(`Missing required argument --${name}`);
    }
  }

  return argumentsByName;
}

function readBoolean(value, name) {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${name} must be true or false; received ${value}`);
}

function sanitizeOperationLog(value) {
  return value
    .replace(/(authorization\s*:\s*bearer)\s+[^\s]+/gi, '$1 [REDACTED]')
    .replace(/((?:password|token|secret)[a-z0-9_]*\s*=)\s*[^\s]*/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|password|secret)=)[^&\s]*/gi, '$1[REDACTED]');
}

function readOperationStage(log) {
  const stages = [...log.matchAll(/^RALLAR_OPERATION_STAGE=([a-z0-9-]+)$/gm)];
  return stages.at(-1)?.[1] ?? 'unknown';
}

function classifyFailure({ status, stage, log, missingArtifacts }) {
  if (missingArtifacts) {
    return {
      failureCategory: 'missing-artifacts',
      component: 'Distributed recipe artifacts',
      nextAction:
        'Inspect artifact collection and the controller run directory before retrying the recipe.',
    };
  }

  if (status === 'succeeded') {
    return {
      failureCategory: 'none',
      component: 'none',
      nextAction: 'No action required.',
    };
  }

  if (/deb\.nodesource\.com/i.test(log) && /403\s+Forbidden/i.test(log)) {
    return {
      failureCategory: 'dependency-repository',
      component: 'NodeSource apt repository',
      nextAction:
        'Retry controller preparation after confirming isolated Ubuntu dependency sources.',
    };
  }

  const classifications = {
    'playwright-system-dependencies': {
      failureCategory: 'browser-dependencies',
      component: 'Playwright system dependencies',
      nextAction: 'Inspect the apt evidence and repair controller browser dependencies.',
    },
    'playwright-browser-install': {
      failureCategory: 'browser-installation',
      component: 'Playwright browser download',
      nextAction: 'Inspect the browser download evidence; the active browser was preserved.',
    },
    'playwright-browser-smoke': {
      failureCategory: 'browser-verification',
      component: 'Playwright browser launch',
      nextAction: 'Inspect the browser launch error before retrying controller preparation.',
    },
    'deployment-readiness': {
      failureCategory: 'deployment-readiness',
      component: 'Hetzner deployment readiness stamp',
      nextAction: 'Run controller preparation for the exact commit before starting recipes.',
    },
    'rollout-service-health': {
      failureCategory: 'service-health',
      component: 'Rallar controller services',
      nextAction: 'Inspect API, control-server, and Caddy service status on the controller.',
    },
    'agent-readiness': {
      failureCategory: 'agent-readiness',
      component: 'Hetzner headless agents',
      nextAction: 'Inspect worker service logs and the control-run agent snapshot.',
    },
    'recipe-execution': {
      failureCategory: 'recipe-execution',
      component: 'Distributed recipe',
      nextAction: 'Open the distributed analysis and cited raw recipe evidence.',
    },
  };

  return (
    classifications[stage] ?? {
      failureCategory: /ssh:/i.test(log) ? 'ssh' : 'unknown',
      component: /ssh:/i.test(log) ? 'Hetzner SSH connection' : 'unknown',
      nextAction: 'Open the sanitized evidence and the failing GitHub Actions step.',
    }
  );
}

function toEvidenceExcerpt(log) {
  return log
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.startsWith('RALLAR_OPERATION_STAGE='))
    .slice(-40)
    .map((line) => line.slice(0, 250))
    .join('\n');
}

function toSummary(report) {
  const recipeSentence = report.recipeStarted
    ? 'The distributed recipe started.'
    : 'The distributed recipe did not start.';
  const artifactSentence = report.distributedArtifactAvailable
    ? 'Distributed artifacts are available.'
    : 'No distributed artifact was created.';

  return [
    '## Hetzner operation diagnostics',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Status | ${report.status} |`,
    `| Phase | ${report.phase} |`,
    `| Stage | ${report.stage} |`,
    `| Failure category | ${report.failureCategory} |`,
    `| Component | ${report.component} |`,
    `| Exit code | ${report.exitCode} |`,
    `| Commit | \`${report.commitSha}\` |`,
    `| Control run | \`${report.controlRunId}\` |`,
    `| Distributed run | \`${report.distributedRunId}\` |`,
    '',
    `${recipeSentence} ${artifactSentence}`,
    '',
    `**Next action:** ${report.nextAction}`,
    '',
    '<details><summary>Sanitized evidence</summary>',
    '',
    '```text',
    report.evidenceExcerpt || '(no operation output captured)',
    '```',
    '',
    '</details>',
    '',
  ].join('\n');
}

const argumentsByName = readArguments(process.argv.slice(2));
const requestedStatus = argumentsByName.get('status');
if (requestedStatus !== 'succeeded' && requestedStatus !== 'failed') {
  throw new Error(`status must be succeeded or failed; received ${requestedStatus}`);
}

const rawLog = await readFile(argumentsByName.get('log'), 'utf8').catch(() => '');
const sanitizedLog = sanitizeOperationLog(rawLog);
const stage = readOperationStage(sanitizedLog);
const phase = argumentsByName.get('phase');
const distributedArtifactAvailable = readBoolean(
  argumentsByName.get('artifact-available'),
  'artifact-available',
);
const missingArtifacts =
  requestedStatus === 'succeeded' && phase !== 'prepare' && !distributedArtifactAvailable;
const status = missingArtifacts ? 'failed' : requestedStatus;
const classification = classifyFailure({
  status,
  stage,
  log: sanitizedLog,
  missingArtifacts,
});
const report = {
  schemaVersion: 1,
  status,
  phase,
  stage,
  failureCategory: classification.failureCategory,
  component: classification.component,
  exitCode: Number(argumentsByName.get('exit-code')),
  commitSha: argumentsByName.get('commit'),
  manifestPath: argumentsByName.get('manifest'),
  controlRunId: argumentsByName.get('control-run-id'),
  distributedRunId: argumentsByName.get('distributed-run-id'),
  distributedArtifactAvailable,
  recipeStarted: /^RALLAR_OPERATION_STAGE=recipe-execution$/m.test(sanitizedLog),
  startedAt: argumentsByName.get('started-at'),
  finishedAt: argumentsByName.get('finished-at'),
  evidenceExcerpt: toEvidenceExcerpt(sanitizedLog),
  nextAction: classification.nextAction,
};

if (!Number.isInteger(report.exitCode) || report.exitCode < 0) {
  throw new Error(`exit-code must be a non-negative integer; received ${report.exitCode}`);
}

const outputDirectory = path.resolve(argumentsByName.get('output-dir'));
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  path.join(outputDirectory, 'operation-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
await writeFile(path.join(outputDirectory, 'summary.md'), toSummary(report));
await writeFile(path.join(outputDirectory, 'evidence.log'), `${report.evidenceExcerpt}\n`);
