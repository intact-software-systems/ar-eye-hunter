#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const STATE_WRITE_ARTIFACT_SCHEMA_VERSION = 'rallar.api-v1.state-write.v1';

const WORKLOADS = new Map([
  ['uncontended', { clients: 100, groups: 100, concurrency: 10 }],
  ['shared', { clients: 100, groups: 5, concurrency: 10 }],
  ['hot', { clients: 100, groups: 1, concurrency: 10 }],
]);

const MUTATION_MIX = [
  'profile-instance',
  'membership',
  'presence-connect',
  'presence-heartbeat',
  'presence-disconnect',
  'config',
  'topology-source',
];

const TIMING_BUCKETS = ['read', 'compute', 'validate', 'write', 'transaction', 'outbox'];
const SQL_METRICS = ['statements', 'rowsRead', 'serializedResultBytes'];
const POSTGRES_METRICS = [
  'transactionDurationMs',
  'lockWaitMs',
  'cpuTimeMs',
  'sharedBufferHits',
  'sharedBufferReads',
  'walBytes',
];
const OUTCOME_METRICS = [
  'accepted',
  'conflicted',
  'exhausted',
  'attempts',
  'attemptsPerAcceptedMutation',
];
const CORRECTNESS_METRICS = [
  'acceptedCommandCount',
  'receiptCount',
  'effectfulCommandCount',
  'requiredOutboxIntentCount',
  'outboxIntentCount',
];

export function validateStateWriteArtifact(artifact) {
  const errors = [];
  if (!isObject(artifact)) {
    return ['artifact must be an object'];
  }

  if (artifact.schemaVersion !== STATE_WRITE_ARTIFACT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${STATE_WRITE_ARTIFACT_SCHEMA_VERSION}`);
  }
  if (typeof artifact.gitCommit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(artifact.gitCommit)) {
    errors.push('gitCommit must be a 7-40 character hexadecimal commit');
  }
  if (typeof artifact.backend !== 'string' || artifact.backend.length === 0) {
    errors.push('backend must be a non-empty string');
  }
  if (
    typeof artifact.generatedAt !== 'string' || !Number.isFinite(Date.parse(artifact.generatedAt))
  ) {
    errors.push('generatedAt must be an ISO timestamp');
  }

  validateMeasurement(artifact.measurement, errors);

  if (!Array.isArray(artifact.workloads)) {
    errors.push('workloads must be an array');
    return errors;
  }
  const names = artifact.workloads.map((workload) => workload?.name);
  if (
    names.length !== WORKLOADS.size ||
    [...WORKLOADS.keys()].some((name) =>
      names.filter((candidate) => candidate === name).length !== 1
    )
  ) {
    errors.push('workloads must contain uncontended, shared, and hot exactly once');
  }

  for (const [index, workload] of artifact.workloads.entries()) {
    validateWorkload(workload, artifact.measurement, `workloads[${index}]`, errors);
  }

  if (artifact.features !== undefined) {
    if (
      !isObject(artifact.features) ||
      typeof artifact.features.presenceSplitFromGroupAggregate !== 'boolean'
    ) {
      errors.push(
        'features.presenceSplitFromGroupAggregate must be boolean when features is present',
      );
    }
  }
  if (artifact.regressionReasons !== undefined && !Array.isArray(artifact.regressionReasons)) {
    errors.push('regressionReasons must be an array when present');
  }

  return errors;
}

export function compareStateWriteArtifacts(baseline, candidate) {
  const errors = [
    ...validateStateWriteArtifact(baseline).map((error) => `baseline: ${error}`),
    ...validateStateWriteArtifact(candidate).map((error) => `candidate: ${error}`),
  ];
  if (errors.length > 0) {
    return errors;
  }
  if (baseline.backend !== candidate.backend) {
    errors.push(`backend differs: baseline=${baseline.backend}, candidate=${candidate.backend}`);
  }

  const baselineByName = new Map(baseline.workloads.map((workload) => [workload.name, workload]));
  const candidateByName = new Map(candidate.workloads.map((workload) => [workload.name, workload]));
  const uncontendedBaseline = baselineByName.get('uncontended');
  const uncontendedCandidate = candidateByName.get('uncontended');

  compareMaximumRegression(
    errors,
    'uncontended latency p95',
    uncontendedBaseline.summary.latencyMs.p95,
    uncontendedCandidate.summary.latencyMs.p95,
    0.05,
  );
  compareMaximumRegression(
    errors,
    'uncontended latency p99',
    uncontendedBaseline.summary.latencyMs.p99,
    uncontendedCandidate.summary.latencyMs.p99,
    0.05,
  );

  for (const name of ['shared', 'hot']) {
    const baselineWorkload = baselineByName.get(name);
    const candidateWorkload = candidateByName.get(name);
    if (
      candidateWorkload.summary.throughputPerSecond < baselineWorkload.summary.throughputPerSecond
    ) {
      errors.push(
        `${name} throughput regressed: baseline=${baselineWorkload.summary.throughputPerSecond}, ` +
          `candidate=${candidateWorkload.summary.throughputPerSecond}`,
      );
    }
  }
  if (
    candidate.features?.presenceSplitFromGroupAggregate === true &&
    candidateByName.get('shared').summary.throughputPerSecond <=
      baselineByName.get('shared').summary.throughputPerSecond
  ) {
    errors.push('shared throughput must improve after presence is split from the group aggregate');
  }

  for (const name of WORKLOADS.keys()) {
    const baselineWorkload = baselineByName.get(name);
    const candidateWorkload = candidateByName.get(name);
    for (
      const [container, metric] of [
        ['sql', 'statements'],
        ['sql', 'rowsRead'],
        ['sql', 'serializedResultBytes'],
        ['postgres', 'transactionDurationMs'],
      ]
    ) {
      const baselineMedian = median(
        baselineWorkload.samples.map((sample) => sample[container][metric]),
      );
      const candidateMedian = median(
        candidateWorkload.samples.map((sample) => sample[container][metric]),
      );
      if (
        candidateMedian > baselineMedian &&
        !hasRecordedReason(candidate, name, `${container}.${metric}`)
      ) {
        errors.push(
          `${name} median ${container}.${metric} increased without a recorded reason: ` +
            `baseline=${baselineMedian}, candidate=${candidateMedian}`,
        );
      }
    }
  }

  for (const name of ['uncontended', 'shared']) {
    const exhausted = candidateByName.get(name).summary.outcomes.exhausted;
    if (exhausted !== 0) {
      errors.push(`${name} retry exhaustion must remain zero; received ${exhausted}`);
    }
  }
  const baselineHotExhausted = baselineByName.get('hot').summary.outcomes.exhausted;
  const candidateHotExhausted = candidateByName.get('hot').summary.outcomes.exhausted;
  if (candidateHotExhausted > baselineHotExhausted) {
    errors.push(
      `hot retry exhaustion exceeded baseline: baseline=${baselineHotExhausted}, ` +
        `candidate=${candidateHotExhausted}`,
    );
  }

  for (const name of WORKLOADS.keys()) {
    const baselineWorkload = baselineByName.get(name);
    const candidateWorkload = candidateByName.get(name);
    const baselineFailures = correctnessFailures(baselineWorkload.summary.correctness);
    if (
      baselineFailures.length > 0 &&
      baselineWorkload.summary.correctness.dbwFindings.length === 0
    ) {
      errors.push(
        `${name} baseline correctness already fails (${
          baselineFailures.join(', ')
        }) but has no DBW finding linkage`,
      );
    }
    for (const failure of correctnessFailures(candidateWorkload.summary.correctness)) {
      errors.push(`${name} candidate correctness failed: ${failure}`);
    }
  }

  return errors;
}

function validateMeasurement(measurement, errors) {
  if (!isObject(measurement)) {
    errors.push('measurement must be an object');
    return;
  }
  if (measurement.warmupRuns !== 1) {
    errors.push('measurement.warmupRuns must equal 1');
  }
  if (!Number.isInteger(measurement.measuredRuns) || measurement.measuredRuns < 3) {
    errors.push('measurement.measuredRuns must be an integer >= 3');
  }
  if (measurement.concurrency !== 10) {
    errors.push('measurement.concurrency must equal 10');
  }
  if (measurement.tailSamplesDiscarded !== false) {
    errors.push('measurement.tailSamplesDiscarded must be false');
  }
  const exclusions = measurement.mutationTimingExcludes;
  if (
    !Array.isArray(exclusions) ||
    !['setup', 'authentication', 'http'].every((value) => exclusions.includes(value))
  ) {
    errors.push('measurement.mutationTimingExcludes must include setup, authentication, and http');
  }
}

function validateWorkload(workload, measurement, path, errors) {
  if (!isObject(workload)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const expectedScale = WORKLOADS.get(workload.name);
  if (!expectedScale) {
    errors.push(`${path}.name is not a supported workload`);
  } else {
    for (const [key, value] of Object.entries(expectedScale)) {
      if (workload.scale?.[key] !== value) {
        errors.push(`${path}.scale.${key} must equal ${value}`);
      }
    }
  }
  if (JSON.stringify(workload.mutationMix) !== JSON.stringify(MUTATION_MIX)) {
    errors.push(`${path}.mutationMix must contain the exact deterministic mutation mix`);
  }
  if (workload.warmupRuns !== 1 || workload.warmupRuns !== measurement?.warmupRuns) {
    errors.push(`${path}.warmupRuns must equal measurement.warmupRuns and 1`);
  }
  if (workload.measuredRuns !== measurement?.measuredRuns) {
    errors.push(`${path}.measuredRuns must equal measurement.measuredRuns`);
  }
  if (!Array.isArray(workload.samples) || workload.samples.length !== measurement?.measuredRuns) {
    errors.push(`${path}.samples must contain exactly measurement.measuredRuns entries`);
  } else {
    for (const [index, sample] of workload.samples.entries()) {
      validateMetrics(sample, `${path}.samples[${index}]`, errors, true);
      if (sample.runIndex !== index) {
        errors.push(`${path}.samples[${index}].runIndex must equal ${index}`);
      }
      requireMetric(sample, 'durationMs', `${path}.samples[${index}]`, errors);
      if (!Array.isArray(sample.latencySamplesMs) || sample.latencySamplesMs.length === 0) {
        errors.push(`${path}.samples[${index}].latencySamplesMs must be a non-empty array`);
      } else if (sample.latencySamplesMs.some((value) => !isNonNegativeNumber(value))) {
        errors.push(`${path}.samples[${index}].latencySamplesMs must contain non-negative numbers`);
      }
    }
  }
  validateMetrics(workload.summary, `${path}.summary`, errors, false);
}

function validateMetrics(metrics, path, errors, rawSample) {
  if (!isObject(metrics)) {
    errors.push(`${path} must be an object`);
    return;
  }
  requireMetric(metrics, 'throughputPerSecond', path, errors);
  for (const metric of ['p50', 'p95', 'p99']) {
    requireMetric(metrics.latencyMs, metric, `${path}.latencyMs`, errors);
  }
  for (const metric of OUTCOME_METRICS) {
    requireMetric(metrics.outcomes, metric, `${path}.outcomes`, errors);
  }
  for (const metric of SQL_METRICS) {
    requireMetric(metrics.sql, metric, `${path}.sql`, errors);
  }
  for (const metric of POSTGRES_METRICS) {
    requireMetric(metrics.postgres, metric, `${path}.postgres`, errors);
  }
  for (const metric of TIMING_BUCKETS) {
    requireMetric(metrics.timingsMs, metric, `${path}.timingsMs`, errors);
  }
  for (const metric of CORRECTNESS_METRICS) {
    requireMetric(metrics.correctness, metric, `${path}.correctness`, errors);
  }
  if (!Array.isArray(metrics.correctness?.dbwFindings)) {
    errors.push(`${path}.correctness.dbwFindings must be an array`);
  }
  if (rawSample && metrics.outcomes?.accepted !== metrics.correctness?.acceptedCommandCount) {
    errors.push(`${path} accepted outcome and correctness command count must agree`);
  }
}

function requireMetric(container, metric, path, errors) {
  if (!isObject(container) || !isNonNegativeNumber(container[metric])) {
    errors.push(`${path}.${metric} must be a non-negative finite number`);
  }
}

function correctnessFailures(correctness) {
  const failures = [];
  if (correctness.acceptedCommandCount !== correctness.receiptCount) {
    failures.push(
      `accepted commands (${correctness.acceptedCommandCount}) != receipts (${correctness.receiptCount})`,
    );
  }
  if (correctness.requiredOutboxIntentCount !== correctness.outboxIntentCount) {
    failures.push(
      `required outbox intents (${correctness.requiredOutboxIntentCount}) != actual intents (${correctness.outboxIntentCount})`,
    );
  }
  return failures;
}

function compareMaximumRegression(errors, label, baseline, candidate, ratio) {
  const maximum = baseline * (1 + ratio);
  if (candidate > maximum) {
    errors.push(
      `${label} regressed by more than ${
        ratio * 100
      }%: baseline=${baseline}, candidate=${candidate}`,
    );
  }
}

function hasRecordedReason(candidate, workload, metric) {
  return candidate.regressionReasons?.some((entry) =>
    entry && entry.workload === workload && entry.metric === metric &&
    typeof entry.reason === 'string' && entry.reason.trim().length > 0
  ) ?? false;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

async function main() {
  const [baselinePath, candidatePath] = process.argv.slice(2);
  if (!baselinePath || !candidatePath) {
    throw new Error('Usage: compare-api-v1-state-write-results.mjs <baseline> <candidate>');
  }
  const [baseline, candidate] = await Promise.all([
    readArtifact(baselinePath),
    readArtifact(candidatePath),
  ]);
  const errors = compareStateWriteArtifacts(baseline, candidate);
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('API-v1 state-write performance comparison passed.');
}

async function readArtifact(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
