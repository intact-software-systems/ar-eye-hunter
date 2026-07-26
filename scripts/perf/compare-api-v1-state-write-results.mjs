#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const STATE_WRITE_ARTIFACT_SCHEMA_VERSION = 'rallar.api-v1.state-write.v3';
export const STATE_WRITE_COMMANDS_PER_RUN = 700;

export const LEGACY_STATE_WRITE_MUTATION_CONTRACT = Object.freeze({
  'profile-instance': Object.freeze([
    'client-snapshot:profile',
    'client-event:profile',
    'client-snapshot:instance',
    'client-event:instance',
  ]),
  membership: Object.freeze(['group-snapshot', 'group-event', 'topology-publication']),
  'presence-connect': Object.freeze(['group-snapshot', 'group-event', 'topology-publication']),
  'presence-heartbeat': Object.freeze([]),
  'presence-disconnect': Object.freeze([
    'group-snapshot',
    'group-event',
    'topology-publication',
  ]),
  config: Object.freeze(['group-snapshot', 'group-event', 'topology-publication']),
  'topology-source': Object.freeze(['topology-publication']),
});

export const PRODUCTION_STATE_WRITE_MUTATION_CONTRACT = Object.freeze({
  'profile-instance': Object.freeze([
    'principal-state:snapshot',
    'principal-state:event',
    'principal-state:snapshot',
    'principal-state:event',
  ]),
  membership: Object.freeze(['group-presence-summary']),
  'presence-connect': Object.freeze(['group-presence-summary']),
  'presence-heartbeat': Object.freeze(['group-presence-summary']),
  'presence-disconnect': Object.freeze(['group-presence-summary']),
  config: Object.freeze(['group-presence-summary']),
  'topology-source': Object.freeze(['rtc-topology-recompute']),
});

export const STATE_WRITE_MUTATION_CONTRACT = LEGACY_STATE_WRITE_MUTATION_CONTRACT;

const WORKLOADS = new Map([
  ['uncontended', { clients: 100, groups: 100, concurrency: 10 }],
  ['shared', { clients: 100, groups: 5, concurrency: 10 }],
  ['hot', { clients: 100, groups: 1, concurrency: 10 }],
]);
const MUTATION_MIX = Object.keys(LEGACY_STATE_WRITE_MUTATION_CONTRACT);
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
const COUNTER_SOURCES = [
  'sql',
  'rowsRead',
  'serializedResultBytes',
  'transactionDuration',
  'lockWait',
  'cpu',
  'sharedBuffers',
  'wal',
  'readTiming',
  'computeTiming',
  'validateTiming',
  'writeTiming',
  'outboxTiming',
  'attempts',
  'receipts',
  'outboxIntents',
];
const DBW_FINDING_PATTERN = /^DBW-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const REGRESSION_REASON_METRICS = new Set([
  'sql.statements',
  'sql.rowsRead',
  'sql.serializedResultBytes',
  'postgres.transactionDurationMs',
]);

export function validateStateWriteArtifact(
  artifact,
  options = {},
) {
  try {
    return validateStateWriteArtifactInternal(artifact, options);
  } catch (error) {
    return [
      `artifact contains malformed nested data that could not be derived safely: ${
        errorMessage(error)
      }`,
    ];
  }
}

function validateStateWriteArtifactInternal(
  artifact,
  { allowDbwLinkedDurableDefects = true } = {},
) {
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
  if (artifact.backend !== 'postgres') {
    errors.push('backend must equal postgres');
  }
  if (
    typeof artifact.generatedAt !== 'string' || !Number.isFinite(Date.parse(artifact.generatedAt))
  ) {
    errors.push('generatedAt must be an ISO timestamp');
  }

  validateMeasurement(artifact.measurement, errors);
  validateFeatures(artifact.features, errors);
  const durableContract = durableContractForArtifact(artifact);
  if (durableContract.name === 'production') {
    validateFinalEvidenceSources(artifact.measurement, errors);
  }

  if (!isDenseArray(artifact.workloads)) {
    errors.push('workloads must be a dense array');
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
    validateWorkload(
      workload,
      artifact.measurement,
      `workloads[${index}]`,
      errors,
      allowDbwLinkedDurableDefects,
      durableContract,
    );
  }
  validateRegressionReasons(artifact.regressionReasons, errors);
  return errors;
}

export function compareStateWriteArtifacts(baseline, candidate) {
  try {
    return compareStateWriteArtifactsInternal(baseline, candidate);
  } catch (error) {
    return [
      `comparison contains malformed nested data that could not be derived safely: ${
        errorMessage(error)
      }`,
    ];
  }
}

function compareStateWriteArtifactsInternal(baseline, candidate) {
  const baselineValidation = validateStateWriteArtifact(baseline);
  const candidateValidation = validateStateWriteArtifact(candidate, {
    allowDbwLinkedDurableDefects: false,
  });
  const errors = [
    ...baselineValidation.map((error) => `baseline: ${error}`),
    ...candidateValidation.map((error) => `candidate: ${error}`),
    ...validateCandidatePresenceSplit(candidate),
  ];
  appendCorrectnessGateErrors(errors, baseline, candidate);
  if (errors.length > 0) {
    return errors;
  }

  const baselineByName = derivedWorkloads(baseline);
  const candidateByName = derivedWorkloads(candidate);
  const uncontendedBaseline = baselineByName.get('uncontended');
  const uncontendedCandidate = candidateByName.get('uncontended');
  compareMaximumRegression(
    errors,
    'uncontended latency p95',
    uncontendedBaseline.latencyMs.p95,
    uncontendedCandidate.latencyMs.p95,
    0.05,
  );
  compareMaximumRegression(
    errors,
    'uncontended latency p99',
    uncontendedBaseline.latencyMs.p99,
    uncontendedCandidate.latencyMs.p99,
    0.05,
  );

  for (const name of ['shared', 'hot']) {
    const baselineThroughput = baselineByName.get(name).throughputPerSecond;
    const candidateThroughput = candidateByName.get(name).throughputPerSecond;
    if (candidateThroughput < baselineThroughput) {
      errors.push(
        `${name} throughput regressed: baseline=${baselineThroughput}, ` +
          `candidate=${candidateThroughput}`,
      );
    }
  }
  if (
    candidateByName.get('shared').throughputPerSecond <=
      baselineByName.get('shared').throughputPerSecond
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
      const baselineMedian = baselineWorkload[container][metric];
      const candidateMedian = candidateWorkload[container][metric];
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
    const exhausted = candidateByName.get(name).outcomes.exhausted;
    if (exhausted !== 0) {
      errors.push(`${name} retry exhaustion must remain zero; received ${exhausted}`);
    }
  }
  const baselineHotExhausted = baselineByName.get('hot').outcomes.exhausted;
  const candidateHotExhausted = candidateByName.get('hot').outcomes.exhausted;
  if (candidateHotExhausted > baselineHotExhausted) {
    errors.push(
      `hot retry exhaustion exceeded baseline: baseline=${baselineHotExhausted}, ` +
        `candidate=${candidateHotExhausted}`,
    );
  }

  return errors;
}

function appendCorrectnessGateErrors(errors, baseline, candidate) {
  if (!hasDerivableWorkloads(baseline) || !hasDerivableWorkloads(candidate)) {
    return;
  }
  const baselineByName = derivedWorkloads(baseline);
  const candidateByName = derivedWorkloads(candidate);
  for (const name of WORKLOADS.keys()) {
    const baselineCorrectness = baselineByName.get(name)?.correctness;
    const candidateCorrectness = candidateByName.get(name)?.correctness;
    if (!baselineCorrectness || !candidateCorrectness) {
      continue;
    }
    const baselineFailures = correctnessFailures(baselineCorrectness);
    if (baselineFailures.length > 0 && baselineCorrectness.dbwFindings.length === 0) {
      errors.push(
        `${name} baseline correctness already fails (${
          baselineFailures.join(', ')
        }) but has no DBW finding linkage`,
      );
    }
    for (const failure of correctnessFailures(candidateCorrectness)) {
      errors.push(`${name} candidate correctness failed: ${failure}`);
    }
  }
}

function hasDerivableWorkloads(artifact) {
  return isDenseArray(artifact?.workloads, WORKLOADS.size) &&
    artifact.workloads.every((workload) =>
      WORKLOADS.has(workload?.name) && isDenseArray(workload.samples) &&
      workload.samples.length > 0 && workload.samples.every(canDeriveWorkloadSample)
    );
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
  if (
    !isDenseArray(measurement.mutationTimingExcludes) ||
    !measurement.mutationTimingExcludes.includes('setup') ||
    !measurement.mutationTimingExcludes.includes('http') ||
    !(
      measurement.mutationTimingExcludes.includes('authentication') ||
      measurement.mutationTimingExcludes.includes('auth-session insertion')
    )
  ) {
    errors.push(
      'measurement.mutationTimingExcludes must be a dense array including setup, http, and either legacy authentication or auth-session insertion',
    );
  }
  for (const source of COUNTER_SOURCES) {
    if (
      !isObject(measurement.counterSources) ||
      typeof measurement.counterSources[source] !== 'string' ||
      measurement.counterSources[source].trim().length === 0
    ) {
      errors.push(`measurement.counterSources.${source} must be a non-empty disclosure`);
    }
  }
}

function validateFinalEvidenceSources(measurement, errors) {
  if (measurement?.counterSources?.outbox !== 'resource_inbox') {
    errors.push('measurement.counterSources.outbox must equal resource_inbox');
  }
  if (measurement?.counterSources?.attempts !== 'app_inbox.ri_attempts') {
    errors.push('measurement.counterSources.attempts must equal app_inbox.ri_attempts');
  }
}

function validateFeatures(features, errors) {
  if (!isObject(features)) {
    errors.push('features must be an object with governed presence-split metadata');
    return;
  }
  if (typeof features.presenceSplitFromGroupAggregate !== 'boolean') {
    errors.push('features.presenceSplitFromGroupAggregate must be boolean');
  }
  for (const field of ['governance', 'evidence']) {
    if (typeof features[field] !== 'string' || features[field].trim().length === 0) {
      errors.push(`features.${field} must be a non-empty string`);
    }
  }
}

function durableContractForArtifact(artifact) {
  return artifact?.features?.governance === 'pre-remediation-baseline'
    ? {
      name: 'legacy',
      mutations: LEGACY_STATE_WRITE_MUTATION_CONTRACT,
      topologyDiagnostic: false,
    }
    : {
      name: 'production',
      mutations: PRODUCTION_STATE_WRITE_MUTATION_CONTRACT,
      topologyDiagnostic:
        artifact?.features?.governance === 'task4-production-evidence-diagnostic',
    };
}

function validateRegressionReasons(reasons, errors) {
  if (!isDenseArray(reasons)) {
    errors.push('regressionReasons must be a dense array');
    return;
  }
  const expectedFields = ['metric', 'reason', 'workload'];
  for (const [index, entry] of reasons.entries()) {
    const path = `regressionReasons[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    const fields = Object.keys(entry).sort();
    if (!sameStringArray(fields, expectedFields)) {
      errors.push(`${path} must contain exactly workload, metric, and reason`);
    }
    if (!WORKLOADS.has(entry.workload)) {
      errors.push(`${path}.workload must be uncontended, shared, or hot`);
    }
    if (!REGRESSION_REASON_METRICS.has(entry.metric)) {
      errors.push(`${path}.metric is not a supported regression metric`);
    }
    if (!isSubstantiveRegressionReason(entry.reason)) {
      errors.push(`${path}.reason must contain at least 10 non-whitespace characters`);
    }
  }
}

export function isSubstantiveRegressionReason(value) {
  return typeof value === 'string' && value.replaceAll(/\s/g, '').length >= 10;
}

function validateCandidatePresenceSplit(candidate) {
  const features = candidate?.features;
  if (
    features?.presenceSplitFromGroupAggregate !== true ||
    features?.governance !== 'task10-post-remediation-candidate' ||
    typeof features?.evidence !== 'string' ||
    features.evidence.trim().length === 0
  ) {
    return [
      'candidate must declare presenceSplitFromGroupAggregate=true with ' +
      'task10-post-remediation-candidate governance and evidence',
    ];
  }
  return [];
}

function validateWorkload(
  workload,
  measurement,
  path,
  errors,
  allowDbwLinkedDurableDefects,
  durableContract,
) {
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
  if (
    !isDenseArray(workload.mutationMix) ||
    !sameStringArray(workload.mutationMix, MUTATION_MIX)
  ) {
    errors.push(`${path}.mutationMix must be a dense exact deterministic mutation mix`);
  }
  if (workload.warmupRuns !== 1 || workload.warmupRuns !== measurement?.warmupRuns) {
    errors.push(`${path}.warmupRuns must equal measurement.warmupRuns and 1`);
  }
  if (workload.measuredRuns !== measurement?.measuredRuns) {
    errors.push(`${path}.measuredRuns must equal measurement.measuredRuns`);
  }
  if (!isDenseArray(workload.samples, measurement?.measuredRuns)) {
    errors.push(
      `${path}.samples must contain exactly measurement.measuredRuns entries as a dense array`,
    );
  } else {
    for (const [index, sample] of workload.samples.entries()) {
      validateSample(
        sample,
        `${path}.samples[${index}]`,
        index,
        errors,
        allowDbwLinkedDurableDefects,
        durableContract,
      );
    }
    if (workload.samples.length > 0 && workload.samples.every(canDeriveWorkloadSample)) {
      const derived = deriveWorkloadSummary(workload.samples, durableContract.mutations);
      validateDerivedSummary(workload.summary, derived, `${path}.summary`, errors);
    } else if (workload.samples.length > 0) {
      errors.push(`${path}.summary cannot be derived from structurally malformed samples`);
    }
  }
}

function validateSample(
  sample,
  path,
  runIndex,
  errors,
  allowDbwLinkedDurableDefects,
  durableContract,
) {
  validateMetrics(sample, path, errors);
  if (!isObject(sample)) {
    return;
  }
  if (sample.runIndex !== runIndex) {
    errors.push(`${path}.runIndex must equal ${runIndex}`);
  }
  requireMetric(sample, 'durationMs', path, errors);
  if (!isDenseArray(sample.latencySamplesMs, STATE_WRITE_COMMANDS_PER_RUN)) {
    errors.push(
      `${path}.latencySamplesMs must contain exactly 700 command latencies as a dense array`,
    );
  }
  if (!isDenseArray(sample.commands, STATE_WRITE_COMMANDS_PER_RUN)) {
    errors.push(`${path}.commands must be a dense array of exactly 700 raw command records`);
    return;
  }

  const commandIds = new Set();
  const commandsById = new Map();
  const kindCounts = new Map(MUTATION_MIX.map((kind) => [kind, 0]));
  const stackCounts = [0, 0];
  let rawCommandPrefix;
  for (const [index, command] of sample.commands.entries()) {
    const commandPath = `${path}.commands[${index}]`;
    if (
      !isObject(command) || typeof command.commandId !== 'string' || command.commandId.length === 0
    ) {
      errors.push(`${commandPath}.commandId must be non-empty`);
      continue;
    }
    if (commandIds.has(command.commandId)) {
      errors.push(`${path}.command IDs must be unique`);
    }
    commandIds.add(command.commandId);
    commandsById.set(command.commandId, command);
    const expectedKind = MUTATION_MIX[Math.floor(index / 100)];
    if (command.kind !== expectedKind) {
      errors.push(`${commandPath}.kind must preserve canonical raw mutation slot order`);
    }
    const identity = parseRawCommandClientIdentity(command);
    if (identity === undefined || identity.clientOrdinal !== String(index % 100)) {
      errors.push(`${commandPath}.command ID must encode its canonical raw client slot`);
    } else if (rawCommandPrefix === undefined) {
      rawCommandPrefix = identity.prefix;
    } else if (identity.prefix !== rawCommandPrefix) {
      errors.push(`${commandPath}.command ID must share the sample command prefix`);
    }
    if (!MUTATION_MIX.includes(command.kind)) {
      errors.push(`${commandPath}.kind is not in the mutation contract`);
    } else {
      kindCounts.set(command.kind, kindCounts.get(command.kind) + 1);
    }
    if (!['accepted', 'exhausted'].includes(command.status)) {
      errors.push(`${commandPath}.status must be accepted or exhausted`);
    }
    if (!isNonNegativeNumber(command.latencyMs)) {
      errors.push(`${commandPath}.latencyMs must be non-negative`);
    }
    if (sample.latencySamplesMs?.[index] !== command.latencyMs) {
      errors.push(`${path}.latencySamplesMs must exactly preserve raw command latency order`);
    }
    if (command.stackIndex !== 0 && command.stackIndex !== 1) {
      errors.push(`${commandPath}.stackIndex must be 0 or 1`);
    } else {
      stackCounts[command.stackIndex] += 1;
    }
  }
  for (const kind of MUTATION_MIX) {
    if (kindCounts.get(kind) !== 100) {
      errors.push(`${path}.commands must contain exactly 100 ${kind} commands`);
    }
  }
  if (stackCounts.some((count) => count === 0)) {
    errors.push(`${path}: both independent service stacks must execute commands`);
  }
  if (!isDenseArray(sample.stackCommandCounts, stackCounts.length)) {
    errors.push(`${path}.stackCommandCounts must be a dense array of two finite numbers`);
  } else if (!sameNumericArray(sample.stackCommandCounts, stackCounts)) {
    errors.push(`${path}.stackCommandCounts does not match raw commands`);
  }

  const dbwFindings = Array.isArray(sample.correctness?.dbwFindings)
    ? sample.correctness.dbwFindings
    : [];
  const attempts = deriveAttempts(
    sample.attemptObservations,
    commandsById,
    path,
    errors,
    durableContract,
  );
  compareNumber(
    sample.outcomes?.attempts,
    attempts.attempts,
    `${path}.outcomes.attempts`,
    errors,
    'attempt observations',
  );
  compareNumber(
    sample.outcomes?.conflicted,
    attempts.conflicted,
    `${path}.outcomes.conflicted`,
    errors,
    'attempt observations',
  );
  compareNumber(
    sample.outcomes?.exhausted,
    attempts.exhausted,
    `${path}.outcomes.exhausted`,
    errors,
    'attempt observations',
  );
  compareNumber(
    sample.outcomes?.attemptsPerAcceptedMutation,
    attempts.accepted === 0 ? 0 : attempts.attempts / attempts.accepted,
    `${path}.outcomes.attemptsPerAcceptedMutation`,
    errors,
    'attempt observations',
  );
  const durable = deriveDurableCorrectness(
    sample,
    commandsById,
    dbwFindings,
    path,
    errors,
    allowDbwLinkedDurableDefects,
    durableContract,
  );
  compareNumber(
    sample.correctness?.acceptedCommandCount,
    attempts.accepted,
    `${path}.correctness.acceptedCommandCount`,
    errors,
    'raw commands',
  );
  compareNumber(
    sample.correctness?.receiptCount,
    durable.receiptCount,
    `${path}.correctness.receiptCount`,
    errors,
    'durable records',
  );
  compareNumber(
    sample.correctness?.effectfulCommandCount,
    durable.effectfulCommandCount,
    `${path}.correctness.effectfulCommandCount`,
    errors,
    'mutation contract',
  );
  compareNumber(
    sample.correctness?.requiredOutboxIntentCount,
    durable.requiredOutboxIntentCount,
    `${path}.correctness.requiredOutboxIntentCount`,
    errors,
    'mutation contract',
  );
  compareNumber(
    sample.correctness?.outboxIntentCount,
    durable.outboxIntentCount,
    `${path}.correctness.outboxIntentCount`,
    errors,
    'durable records',
  );
  compareNumber(
    sample.outcomes?.accepted,
    attempts.accepted,
    `${path}.outcomes.accepted`,
    errors,
    'raw commands',
  );

  const latency = percentileSummary(sample.commands.map((command) => command.latencyMs));
  for (const metric of ['p50', 'p95', 'p99']) {
    compareNumber(
      sample.latencyMs?.[metric],
      latency[metric],
      `${path}.latencyMs.${metric}`,
      errors,
      'raw samples',
    );
  }
  compareNumber(
    sample.throughputPerSecond,
    attempts.accepted / (sample.durationMs / 1_000),
    `${path}.throughputPerSecond`,
    errors,
    'raw commands',
  );
}

function deriveAttempts(observations, commandsById, path, errors, durableContract) {
  if (!isDenseArray(observations)) {
    errors.push(`${path}.attemptObservations must be a dense array`);
    return { attempts: 0, conflicted: 0, exhausted: 0, accepted: 0 };
  }
  const histories = new Map();
  let conflicted = 0;
  for (const [index, observation] of observations.entries()) {
    const observationPath = `${path}.attemptObservations[${index}]`;
    if (!isObject(observation) || !commandsById.has(observation.commandId)) {
      errors.push(`${observationPath}.commandId must link to a raw command`);
      continue;
    }
    if (typeof observation.operationId !== 'string' || observation.operationId.length === 0) {
      errors.push(`${observationPath}.operationId must be non-empty`);
      continue;
    }
    if (!Number.isInteger(observation.attempt) || observation.attempt < 0) {
      errors.push(`${observationPath}.attempt must be a non-negative integer`);
    }
    if (!['accepted', 'conflicted', 'exhausted'].includes(observation.outcome)) {
      errors.push(`${observationPath}.outcome is invalid`);
    }
    if (typeof observation.source !== 'string' || observation.source.trim().length === 0) {
      errors.push(`${observationPath}.source must disclose a timing-sink source`);
    }
    const terminalOutcome = observation.outcome === 'accepted' ||
      observation.outcome === 'exhausted';
    if (observation.terminal !== terminalOutcome) {
      errors.push(
        `${observationPath}.terminal must be false for conflicts and true for accepted/exhausted`,
      );
    }
    const historyKey = `${observation.commandId}\u0000${observation.operationId}`;
    const history = histories.get(historyKey) ?? [];
    history.push({ ...observation, index });
    histories.set(historyKey, history);
    conflicted += observation.outcome === 'conflicted' ? 1 : 0;
  }

  const historiesByCommand = new Map(
    [...commandsById.keys()].map((commandId) => [commandId, []]),
  );
  const commandOrderById = new Map(
    [...commandsById.keys()].map((commandId, index) => [commandId, index]),
  );
  for (const [historyKey, history] of histories) {
    const separator = historyKey.indexOf('\u0000');
    const commandId = historyKey.slice(0, separator);
    const operationId = historyKey.slice(separator + 1);
    historiesByCommand.get(commandId)?.push({ operationId, history });
    const firstAttempt = history[0]?.attempt;
    const prerequisiteHistory = history.length === 1 &&
      history[0]?.attempt === 1 && history[0]?.outcome === 'exhausted' &&
      history[0]?.terminal === true && history[0]?.source.startsWith(
        'state-write-command-envelope.prerequisite-exhausted:',
      );
    if (prerequisiteHistory) {
      if (durableContract.name === 'production') {
        errors.push(`${path}: ${commandId}/${operationId} service-local prerequisite evidence is forbidden`);
      }
      const prerequisite = history[0].source.slice(
        'state-write-command-envelope.prerequisite-exhausted:'.length,
      );
      const kind = commandsById.get(commandId)?.kind;
      const validPair = prerequisite === 'membership'
        ? kind === 'presence-connect' || kind === 'presence-heartbeat' ||
          kind === 'presence-disconnect'
        : prerequisite === 'presence-connect'
        ? kind === 'presence-heartbeat' || kind === 'presence-disconnect'
        : false;
      if (!validPair) {
        errors.push(`${path}: ${commandId}/${operationId} invalid prerequisite-exhausted command pair`);
      } else {
        const dependent = commandsById.get(commandId);
        const identity = parseRawCommandClientIdentity(dependent);
        const prerequisiteCommandId = identity === undefined
          ? undefined
          : `${identity.prefix}:${prerequisite}:${identity.clientOrdinal}`;
        const prerequisiteCommand = prerequisiteCommandId === undefined
          ? undefined
          : commandsById.get(prerequisiteCommandId);
        if (!prerequisiteCommand || prerequisiteCommand.kind !== prerequisite) {
          errors.push(
            `${path}: ${commandId}/${operationId} missing same-client prerequisite command`,
          );
        } else {
          if (
            (commandOrderById.get(prerequisiteCommandId) ?? Number.MAX_SAFE_INTEGER) >=
              (commandOrderById.get(commandId) ?? -1) ||
            MUTATION_MIX.indexOf(prerequisiteCommand.kind) >= MUTATION_MIX.indexOf(dependent.kind)
          ) {
            errors.push(
              `${path}: ${commandId}/${operationId} prerequisite command must precede dependent command`,
            );
          }
          if (prerequisiteCommand.status !== 'exhausted') {
            errors.push(
              `${path}: ${commandId}/${operationId} prerequisite command must be production-exhausted`,
            );
          } else {
            const prerequisiteHistory = histories.get(
              `${prerequisiteCommandId}\u0000command`,
            );
            if (!isRealGroupProductionExhaustion(prerequisiteHistory)) {
              errors.push(
                `${path}: ${commandId}/${operationId} prerequisite command must end in ` +
                  'production conflict exhaustion',
              );
            }
          }
        }
      }
    }
    const expectedFirstAttempt = 1;
    if (firstAttempt !== expectedFirstAttempt) {
      errors.push(
        `${path}: ${commandId}/${operationId} ${durableContract.name} attempts must ` +
          `start at ${expectedFirstAttempt}`,
      );
    }
    if (durableContract.name === 'production' && !prerequisiteHistory) {
      for (const observation of history) {
        if (
          observation.source !== 'app_inbox.ri_attempts' ||
          !isNonNegativeNumber(observation.retryDelayMs) ||
          !isNonNegativeNumber(observation.dueAgeMs) ||
          !['fast', 'fairness', 'timeout'].includes(observation.selectedLane)
        ) {
          errors.push(
            `${path}: ${commandId}/${operationId} production attempt source is not ` +
              'durable app_inbox.ri_attempts evidence',
          );
          break;
        }
      }
    }
    for (const [index, observation] of history.entries()) {
      if (observation.attempt !== firstAttempt + index) {
        errors.push(
          `${path}: ${commandId}/${operationId} attempt numbers must be ordered and contiguous`,
        );
        break;
      }
    }
    const terminals = history.filter((observation) => observation.terminal === true);
    if (terminals.length !== 1) {
      errors.push(`${path}: ${commandId}/${operationId} must have exactly one terminal outcome`);
    } else if (history.at(-1) !== terminals[0]) {
      errors.push(`${path}: ${commandId}/${operationId} terminal outcome must be last`);
    }
    if (history.slice(0, -1).some((observation) => observation.outcome !== 'conflicted')) {
      errors.push(`${path}: ${commandId}/${operationId} only conflicts may precede a terminal`);
    }
    const terminal = terminals[0];
    if (terminal?.outcome === 'exhausted') {
      const prerequisiteTerminal = history.length === 1 &&
        terminal.source.startsWith(
          'state-write-command-envelope.prerequisite-exhausted:',
        );
      const productionExhaustion = terminal.source === 'app_inbox.ri_attempts' &&
        history.slice(0, -1).some((observation) =>
          observation.outcome === 'conflicted' &&
          observation.source === 'app_inbox.ri_attempts'
        );
      if (!prerequisiteTerminal && !productionExhaustion) {
        errors.push(
          `${path}: ${commandId}/${operationId} production exhaustion must retain ` +
            'a preceding production mutation.conflict observation',
        );
      }
    }
  }

  let accepted = 0;
  let exhausted = 0;
  for (const [commandId, command] of commandsById) {
    const commandHistories = historiesByCommand.get(commandId) ?? [];
    if (commandHistories.length === 0) {
      errors.push(`${path}: attemptObservations must cover raw command ${commandId}`);
      continue;
    }
    const allowedOperations = command.kind === 'profile-instance'
      ? new Set(['profile', 'instance'])
      : new Set(['command']);
    if (commandHistories.some(({ operationId }) => !allowedOperations.has(operationId))) {
      errors.push(`${path}: ${commandId} has an operationId outside its mutation contract`);
    }
    const terminalEvents = commandHistories.flatMap(({ history }) =>
      history.filter((observation) => observation.terminal === true)
    ).sort((left, right) => left.index - right.index);
    const firstExhausted = terminalEvents.findIndex((event) => event.outcome === 'exhausted');
    if (
      firstExhausted >= 0 &&
      terminalEvents.slice(firstExhausted + 1).some((event) => event.outcome === 'accepted')
    ) {
      errors.push(`${path}: ${commandId} cannot accept an operation after exhaustion`);
    }
    const derivedStatus = terminalEvents.some((event) => event.outcome === 'exhausted')
      ? 'exhausted'
      : 'accepted';
    if (command.status !== derivedStatus) {
      errors.push(
        `${path}: ${commandId} status does not match its coherent terminal attempt outcome`,
      );
    }
    if (
      derivedStatus === 'accepted' &&
      commandHistories.length !== allowedOperations.size
    ) {
      errors.push(`${path}: ${commandId} accepted without every required operation terminal`);
    }
    accepted += derivedStatus === 'accepted' ? 1 : 0;
    exhausted += derivedStatus === 'exhausted' ? 1 : 0;
  }
  return { attempts: observations.length, conflicted, exhausted, accepted };
}

function parseRawCommandClientIdentity(command) {
  if (!isObject(command) || typeof command.commandId !== 'string' ||
    typeof command.kind !== 'string') {
    return undefined;
  }
  const marker = `:${command.kind}:`;
  const markerIndex = command.commandId.lastIndexOf(marker);
  if (markerIndex <= 0) return undefined;
  const prefix = command.commandId.slice(0, markerIndex);
  const clientOrdinal = command.commandId.slice(markerIndex + marker.length);
  if (!/^\d+$/.test(clientOrdinal) ||
    command.commandId !== `${prefix}${marker}${clientOrdinal}`) {
    return undefined;
  }
  return { prefix, clientOrdinal };
}

function isRealGroupProductionExhaustion(history) {
  return Array.isArray(history) && history.length >= 2 &&
    history.slice(0, -1).every((observation) =>
      observation.outcome === 'conflicted' && observation.terminal === false &&
      observation.source === 'group-state-service.mutation.conflict'
    ) &&
    history.at(-1)?.outcome === 'exhausted' && history.at(-1)?.terminal === true &&
    history.at(-1)?.source === 'group-state-service.mutation.conflict';
}

function deriveDurableCorrectness(
  sample,
  commandsById,
  dbwFindings,
  path,
  errors,
  allowDbwLinkedDurableDefects,
  durableContract,
) {
  if (durableContract.name === 'production' && !durableContract.topologyDiagnostic) {
    return deriveFinalDurableCorrectness(sample, commandsById, path, errors);
  }
  const receipts = sample.durable?.receiptCommandIds;
  const intents = sample.durable?.outboxIntents;
  const receiptIds = Array.isArray(receipts) ? receipts : [];
  const intentRecords = Array.isArray(intents) ? intents : [];
  if (!isDenseArray(receipts)) {
    errors.push(`${path}.durable.receiptCommandIds must be a dense array`);
  }
  if (!isDenseArray(intents)) {
    errors.push(`${path}.durable.outboxIntents must be a dense array`);
  }
  const canRetainLegacyBaselineDefect = durableContract.name === 'legacy' &&
    allowDbwLinkedDurableDefects &&
    dbwFindings.length > 0 && dbwFindings.every(isValidDbwFinding);
  const canRetainTopologyDiagnostic = durableContract.name === 'production' &&
    durableContract.topologyDiagnostic === true &&
    allowDbwLinkedDurableDefects && dbwFindings.length === 2 &&
    new Set(dbwFindings).size === 2 &&
    dbwFindings.includes('DBW-06') && dbwFindings.includes('DBW-12');
  const acceptedCommands = [...commandsById.values()].filter((command) =>
    command.status === 'accepted'
  );
  for (const [index, receiptCommandId] of receiptIds.entries()) {
    if (
      typeof receiptCommandId !== 'string' || receiptCommandId.trim().length === 0 ||
      !commandsById.has(receiptCommandId)
    ) {
      errors.push(
        `${path}.durable.receiptCommandIds[${index}] must be a non-empty raw command ID`,
      );
    }
  }
  const receiptSet = new Set(receiptIds);
  if (receiptSet.size !== receiptIds.length && !canRetainLegacyBaselineDefect) {
    errors.push(`${path}.durable receipt command IDs must be unique`);
  }
  const acceptedIds = acceptedCommands.map((command) => command.commandId).sort();
  const acceptedNonTopologyIds = acceptedCommands
    .filter((command) => command.kind !== 'topology-source')
    .map((command) => command.commandId)
    .sort();
  const exactTopologyReceiptGap = canRetainTopologyDiagnostic &&
    sameStringArray([...receiptSet].sort(), acceptedNonTopologyIds);
  if (
    !sameStringArray([...receiptSet].sort(), acceptedIds) &&
    !canRetainLegacyBaselineDefect && !exactTopologyReceiptGap
  ) {
    errors.push(`${path}.durable receipts must match accepted command IDs exactly`);
  }

  const intentIds = intentRecords.map((intent) => intent?.intentId);
  if (new Set(intentIds).size !== intentIds.length && !canRetainLegacyBaselineDefect) {
    errors.push(`${path}.durable outbox intent IDs must be unique`);
  }
  const expected = acceptedCommands.flatMap((command) =>
    (durableContract.mutations[command.kind] ?? []).map((intentKind, index) =>
      durableContract.name === 'legacy'
        ? `${command.commandId}:intent:${index}\u0000${command.commandId}\u0000${intentKind}`
        : `${command.commandId}\u0000${intentKind}`
    )
  ).sort();
  const actual = intentRecords.map((intent, index) => {
    if (
      !isObject(intent) ||
      typeof intent.intentId !== 'string' || intent.intentId.trim().length === 0 ||
      typeof intent.commandId !== 'string' || intent.commandId.trim().length === 0 ||
      !commandsById.has(intent.commandId) ||
      typeof intent.intentKind !== 'string' || intent.intentKind.trim().length === 0
    ) {
      errors.push(
        `${path}.durable.outboxIntents[${index}] must contain non-empty intentId, commandId, ` +
          'and intentKind fields and reference a raw command',
      );
    }
    return durableContract.name === 'legacy'
      ? `${intent?.intentId}\u0000${intent?.commandId}\u0000${intent?.intentKind}`
      : `${intent?.commandId}\u0000${intent?.intentKind}`;
  }).sort();
  const expectedWithoutTopology = acceptedCommands
    .filter((command) => command.kind !== 'topology-source')
    .flatMap((command) =>
      (durableContract.mutations[command.kind] ?? []).map((intentKind) =>
        `${command.commandId}\u0000${intentKind}`
      )
    ).sort();
  const exactTopologyIntentGap = canRetainTopologyDiagnostic &&
    sameStringArray(actual, expectedWithoutTopology);
  if (
    !sameStringArray(actual, expected) &&
    !canRetainLegacyBaselineDefect && !exactTopologyIntentGap
  ) {
    errors.push(
      `${path}.durable outbox intents do not match the mutation contract ` +
        `(${durableContract.name} durable contract)`,
    );
  }
  const effectfulCommandCount =
    acceptedCommands.filter((command) =>
      (durableContract.mutations[command.kind]?.length ?? 0) > 0
    )
      .length;
  return {
    receiptCount: receiptIds.length,
    effectfulCommandCount,
    requiredOutboxIntentCount: expected.length,
    outboxIntentCount: intentRecords.length,
  };
}

function deriveFinalDurableCorrectness(sample, commandsById, path, errors) {
  const evidence = sample.durableEvidence;
  if (!isObject(evidence)) {
    errors.push(`${path}.durableEvidence must be an object`);
    return emptyDurableCorrectness();
  }
  for (const field of ['appInbox', 'receipts', 'resourceOutbox', 'intermediateMutationIntents']) {
    if (!isDenseArray(evidence[field])) {
      errors.push(`${path}.durableEvidence.${field} must be a dense array`);
    }
  }
  if (!isDenseArray(evidence.intermediateMutationIntents, 0)) {
    errors.push(`${path}.durableEvidence.intermediateMutationIntents must be exactly empty`);
  }
  if (!Number.isInteger(evidence.atomicCompletionFailures) || evidence.atomicCompletionFailures < 0) {
    errors.push(`${path}.durableEvidence.atomicCompletionFailures must be a non-negative integer`);
  }
  const appInbox = Array.isArray(evidence.appInbox) ? evidence.appInbox : [];
  const receipts = Array.isArray(evidence.receipts) ? evidence.receipts : [];
  const resourceOutbox = Array.isArray(evidence.resourceOutbox) ? evidence.resourceOutbox : [];
  validateAppInboxEvidence(appInbox, commandsById, path, errors);
  const acceptedCommands = [...commandsById.values()].filter((command) => command.status === 'accepted');
  const receiptIds = receipts.map((receipt, index) => {
    if (!isObject(receipt) || typeof receipt.commandId !== 'string' ||
      !commandsById.has(receipt.commandId) || !isDenseStringArray(receipt.receiptIds) ||
      !isDenseStringArray(receipt.outboxIds)) {
      errors.push(`${path}.durableEvidence.receipts[${index}] is malformed or unlinked`);
    }
    return receipt?.commandId;
  });
  if (!sameStringArray(receiptIds.toSorted(), acceptedCommands.map((entry) => entry.commandId).toSorted())) {
    errors.push(`${path}.durableEvidence receipts must match accepted command IDs exactly`);
  }
  const effectIds = new Set();
  const actualEffects = resourceOutbox.map((effect, index) => {
    if (!isObject(effect) || typeof effect.effectId !== 'string' || effect.effectId.length === 0 ||
      typeof effect.commandId !== 'string' || !commandsById.has(effect.commandId) ||
      typeof effect.effectKind !== 'string' || effect.effectKind.length === 0 ||
      typeof effect.resourceId !== 'string' || effect.resourceId.length === 0 ||
      !['APP_OUTBOX', 'WS_OUTBOX'].includes(effect.typeId) ||
      typeof effect.topicId !== 'string' || effect.topicId.length === 0) {
      errors.push(`${path}.durableEvidence.resourceOutbox[${index}] is malformed or unlinked`);
    }
    if (effectIds.has(effect?.effectId)) {
      errors.push(`${path}.durableEvidence resource outbox effect IDs must be unique`);
    }
    effectIds.add(effect?.effectId);
    return `${effect?.commandId}\u0000${effect?.effectKind}`;
  }).toSorted();
  const expectedEffects = acceptedCommands.flatMap((command) =>
    PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].map((effectKind) =>
      `${command.commandId}\u0000${effectKind}`
    )
  ).toSorted();
  if (!sameStringArray(actualEffects, expectedEffects)) {
    errors.push(`${path}.durableEvidence resource outbox does not match the mutation contract`);
  }
  const atomicFailures = deriveAtomicCompletionFailures(
    acceptedCommands,
    appInbox,
    receipts,
    resourceOutbox,
  );
  compareNumber(
    evidence.atomicCompletionFailures,
    atomicFailures,
    `${path}.durableEvidence.atomicCompletionFailures`,
    errors,
    'same-observation durable completion',
  );
  compareNumber(
    sample.correctness?.atomicCompletionFailures,
    atomicFailures,
    `${path}.correctness.atomicCompletionFailures`,
    errors,
    'same-observation durable completion',
  );
  return {
    receiptCount: receipts.length,
    effectfulCommandCount: acceptedCommands.filter((command) =>
      PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].length > 0
    ).length,
    requiredOutboxIntentCount: expectedEffects.length,
    outboxIntentCount: resourceOutbox.length,
  };
}

function validateAppInboxEvidence(entries, commandsById, path, errors) {
  const identities = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!isObject(entry) || typeof entry.commandId !== 'string' ||
      !commandsById.has(entry.commandId) || typeof entry.operationId !== 'string' ||
      entry.operationId.length === 0 || typeof entry.resourceId !== 'string' ||
      entry.resourceId.length === 0 || entry.status !== 'COMPLETED' ||
      entry.resultStatus !== 'COMPLETED' || !Number.isInteger(entry.attempts) ||
      entry.attempts < 1 || !isNonNegativeNumber(entry.retryDelayMs) ||
      !isNonNegativeNumber(entry.dueAgeMs) ||
      !['fast', 'fairness', 'timeout'].includes(entry.selectedLane) ||
      !isNonNegativeNumber(entry.transactionDurationMs)) {
      errors.push(`${path}.durableEvidence.appInbox[${index}] is malformed or incomplete`);
    }
    const identity = `${entry?.commandId}\u0000${entry?.operationId}`;
    if (identities.has(identity)) {
      errors.push(`${path}.durableEvidence AppInbox command/operation identities must be unique`);
    }
    identities.add(identity);
  }
}

function deriveAtomicCompletionFailures(commands, appInbox, receipts, resourceOutbox) {
  return commands.filter((command) => {
    const expectedOperations = command.kind === 'profile-instance'
      ? ['profile', 'instance']
      : ['command'];
    const completedOperations = appInbox.filter((entry) =>
      entry?.commandId === command.commandId && entry.status === 'COMPLETED' &&
      entry.resultStatus === 'COMPLETED'
    ).map((entry) => entry.operationId).toSorted();
    const receipt = receipts.find((entry) => entry?.commandId === command.commandId);
    const expectedEffects = PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].toSorted();
    const actualEffects = resourceOutbox.filter((entry) => entry?.commandId === command.commandId)
      .map((entry) => entry.effectKind).toSorted();
    return !sameStringArray(completedOperations, expectedOperations.toSorted()) ||
      !receipt || !sameStringArray(actualEffects, expectedEffects);
  }).length;
}

function emptyDurableCorrectness() {
  return {
    receiptCount: 0,
    effectfulCommandCount: 0,
    requiredOutboxIntentCount: 0,
    outboxIntentCount: 0,
  };
}

function isDenseStringArray(value) {
  return isDenseArray(value) && value.every((entry) =>
    typeof entry === 'string' && entry.length > 0
  );
}

function validateMetrics(metrics, path, errors) {
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
  validateDbwFindings(metrics.correctness?.dbwFindings, `${path}.correctness`, errors);
}

function validateDbwFindings(findings, path, errors) {
  if (!isDenseArray(findings)) {
    errors.push(`${path}.dbwFindings must be a dense array`);
    return;
  }
  for (const [index, finding] of findings.entries()) {
    if (!isValidDbwFinding(finding)) {
      errors.push(`${path}.dbwFindings[${index}] must be a governed DBW-... finding ID`);
    }
  }
}

function isValidDbwFinding(value) {
  return typeof value === 'string' && DBW_FINDING_PATTERN.test(value);
}

function canDeriveWorkloadSample(sample) {
  return isObject(sample) &&
    isNonNegativeNumber(sample.durationMs) &&
    isDenseArray(sample.commands) &&
    sample.commands.every((command) =>
      isObject(command) && MUTATION_MIX.includes(command.kind) &&
      typeof command.commandId === 'string' &&
      ['accepted', 'exhausted'].includes(command.status) &&
      isNonNegativeNumber(command.latencyMs)
    ) &&
    isDenseArray(sample.attemptObservations) &&
    sample.attemptObservations.every((observation) =>
      isObject(observation) && typeof observation.commandId === 'string' &&
      typeof observation.operationId === 'string' &&
      Number.isInteger(observation.attempt) &&
      ['accepted', 'conflicted', 'exhausted'].includes(observation.outcome) &&
      typeof observation.terminal === 'boolean' &&
      typeof observation.source === 'string'
    ) &&
    ((isObject(sample.durable) &&
      isDenseArray(sample.durable.receiptCommandIds) &&
      isDenseArray(sample.durable.outboxIntents)) ||
      (isObject(sample.durableEvidence) &&
        isDenseArray(sample.durableEvidence.appInbox) &&
        isDenseArray(sample.durableEvidence.receipts) &&
        isDenseArray(sample.durableEvidence.resourceOutbox) &&
        isDenseArray(sample.durableEvidence.intermediateMutationIntents))) &&
    isObject(sample.correctness) &&
    isDenseArray(sample.correctness.dbwFindings) &&
    isObject(sample.sql) &&
    isObject(sample.postgres) &&
    isObject(sample.timingsMs);
}

function deriveWorkloadSummary(samples, mutationContract) {
  const latencySamples = samples.flatMap((sample) =>
    sample.commands.map((command) => command.latencyMs)
  );
  const accepted = sum(
    samples.map((sample) =>
      sample.commands.filter((command) => command.status === 'accepted').length
    ),
  );
  const durationMs = sum(samples.map((sample) => sample.durationMs));
  const attemptMetrics = samples.map((sample) => ({
    attempts: sample.attemptObservations.length,
    conflicted: sample.attemptObservations.filter((entry) => entry.outcome === 'conflicted').length,
    exhausted: sample.commands.filter((command) => command.status === 'exhausted').length,
  }));
  const attempts = sum(attemptMetrics.map((entry) => entry.attempts));
  const dbwFindings = [...new Set(samples.flatMap((sample) => sample.correctness.dbwFindings))];
  return {
    latencyMs: percentileSummary(latencySamples),
    throughputPerSecond: accepted / (durationMs / 1_000),
    outcomes: {
      accepted,
      conflicted: sum(attemptMetrics.map((entry) => entry.conflicted)),
      exhausted: sum(attemptMetrics.map((entry) => entry.exhausted)),
      attempts,
      attemptsPerAcceptedMutation: attempts / accepted,
    },
    sql: medianObject(samples.map((sample) => sample.sql)),
    postgres: medianObject(samples.map((sample) => sample.postgres)),
    timingsMs: medianObject(samples.map((sample) => sample.timingsMs)),
    correctness: {
      acceptedCommandCount: accepted,
      receiptCount: sum(samples.map((sample) =>
        sample.durableEvidence?.receipts?.length ?? sample.durable.receiptCommandIds.length
      )),
      effectfulCommandCount: sum(
        samples.map((sample) =>
          sample.commands.filter((command) =>
            command.status === 'accepted' &&
            mutationContract[command.kind].length > 0
          ).length
        ),
      ),
      requiredOutboxIntentCount: sum(samples.map((sample) =>
        sample.commands.reduce(
          (total, command) =>
            total + (
              command.status === 'accepted' ? mutationContract[command.kind].length : 0
            ),
          0,
        )
      )),
      outboxIntentCount: sum(samples.map((sample) =>
        sample.durableEvidence?.resourceOutbox?.length ?? sample.durable.outboxIntents.length
      )),
      ...(samples.some((sample) => sample.durableEvidence)
        ? {
          atomicCompletionFailures: sum(samples.map((sample) =>
            sample.durableEvidence?.atomicCompletionFailures ?? 0
          )),
        }
        : {}),
      dbwFindings,
    },
  };
}

function validateDerivedSummary(summary, derived, path, errors) {
  validateMetrics(summary, path, errors);
  for (const metric of ['p50', 'p95', 'p99']) {
    compareNumber(
      summary?.latencyMs?.[metric],
      derived.latencyMs[metric],
      `${path}.latencyMs.${metric}`,
      errors,
      'raw samples',
    );
  }
  compareNumber(
    summary?.throughputPerSecond,
    derived.throughputPerSecond,
    `${path}.throughputPerSecond`,
    errors,
    'raw samples',
  );
  for (const metric of OUTCOME_METRICS) {
    compareNumber(
      summary?.outcomes?.[metric],
      derived.outcomes[metric],
      `${path}.outcomes.${metric}`,
      errors,
      'raw samples',
    );
  }
  for (const metric of SQL_METRICS) {
    compareNumber(
      summary?.sql?.[metric],
      derived.sql[metric],
      `${path}.sql.${metric}`,
      errors,
      'sample median',
    );
  }
  for (const metric of POSTGRES_METRICS) {
    compareNumber(
      summary?.postgres?.[metric],
      derived.postgres[metric],
      `${path}.postgres.${metric}`,
      errors,
      'sample median',
    );
  }
  for (const metric of TIMING_BUCKETS) {
    compareNumber(
      summary?.timingsMs?.[metric],
      derived.timingsMs[metric],
      `${path}.timingsMs.${metric}`,
      errors,
      'sample median',
    );
  }
  for (const metric of CORRECTNESS_METRICS) {
    compareNumber(
      summary?.correctness?.[metric],
      derived.correctness[metric],
      `${path}.correctness.${metric}`,
      errors,
      'raw durable samples',
    );
  }
  if (Object.hasOwn(derived.correctness, 'atomicCompletionFailures')) {
    compareNumber(
      summary?.correctness?.atomicCompletionFailures,
      derived.correctness.atomicCompletionFailures,
      `${path}.correctness.atomicCompletionFailures`,
      errors,
      'raw durable samples',
    );
  }
  if (
    !sameStringArray(
      [...(summary?.correctness?.dbwFindings ?? [])].sort(),
      [...derived.correctness.dbwFindings].sort(),
    )
  ) {
    errors.push(`${path}.correctness.dbwFindings does not match raw samples`);
  }
}

function derivedWorkloads(artifact) {
  const contract = durableContractForArtifact(artifact).mutations;
  return new Map(artifact.workloads.map((workload) => [
    workload.name,
    deriveWorkloadSummary(workload.samples, contract),
  ]));
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
  if ((correctness.atomicCompletionFailures ?? 0) !== 0) {
    failures.push(`atomic completion failures (${correctness.atomicCompletionFailures}) != 0`);
  }
  return failures;
}

function percentileSummary(values) {
  return {
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * ratio) - 1];
}

function medianObject(values) {
  return Object.fromEntries(
    Object.keys(values[0]).map((key) => [key, median(values.map((value) => value[key]))]),
  );
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function compareMaximumRegression(errors, label, baseline, candidate, ratio) {
  if (candidate > baseline * (1 + ratio)) {
    errors.push(
      `${label} regressed by more than ${
        ratio * 100
      }%: baseline=${baseline}, candidate=${candidate}`,
    );
  }
}

function hasRecordedReason(candidate, workload, metric) {
  return candidate.regressionReasons.some((entry) =>
    entry && entry.workload === workload && entry.metric === metric &&
    isSubstantiveRegressionReason(entry.reason)
  );
}

function compareNumber(actual, expected, path, errors, source) {
  if (!numbersEqual(actual, expected)) {
    errors.push(`${path} does not match ${source}: expected=${expected}, actual=${actual}`);
  }
}

function numbersEqual(left, right) {
  return isNonNegativeNumber(left) && isNonNegativeNumber(right) &&
    Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-9);
}

function requireMetric(container, metric, path, errors) {
  if (!isObject(container) || !isNonNegativeNumber(container[metric])) {
    errors.push(`${path}.${metric} must be a non-negative finite number`);
  }
}

function sameNumericArray(left, right) {
  if (!isDenseArray(left) || !isDenseArray(right) || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (
      typeof left[index] !== 'number' || !Number.isFinite(left[index]) ||
      typeof right[index] !== 'number' || !Number.isFinite(right[index]) ||
      left[index] !== right[index]
    ) {
      return false;
    }
  }
  return true;
}

function sameStringArray(left, right) {
  if (!isDenseArray(left) || !isDenseArray(right) || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (typeof left[index] !== 'string' || left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function isDenseArray(value, expectedLength) {
  if (
    !Array.isArray(value) ||
    (expectedLength !== undefined && value.length !== expectedLength)
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      return false;
    }
  }
  return true;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
