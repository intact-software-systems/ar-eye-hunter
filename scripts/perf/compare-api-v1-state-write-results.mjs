#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const STATE_WRITE_ARTIFACT_SCHEMA_VERSION = 'rallar.api-v1.state-write.v3';
export const STATE_WRITE_COMMANDS_PER_RUN = 700;

export const STATE_WRITE_MUTATION_CONTRACT = Object.freeze({
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

const WORKLOADS = new Map([
  ['uncontended', { clients: 100, groups: 100, concurrency: 10 }],
  ['shared', { clients: 100, groups: 5, concurrency: 10 }],
  ['hot', { clients: 100, groups: 1, concurrency: 10 }],
]);
const MUTATION_MIX = Object.keys(STATE_WRITE_MUTATION_CONTRACT);
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
    validateWorkload(
      workload,
      artifact.measurement,
      `workloads[${index}]`,
      errors,
      allowDbwLinkedDurableDefects,
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
  return Array.isArray(artifact?.workloads) && artifact.workloads.length === WORKLOADS.size &&
    artifact.workloads.every((workload) =>
      WORKLOADS.has(workload?.name) && Array.isArray(workload.samples) &&
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
    !Array.isArray(measurement.mutationTimingExcludes) ||
    !['setup', 'authentication', 'http'].every((value) =>
      measurement.mutationTimingExcludes.includes(value)
    )
  ) {
    errors.push('measurement.mutationTimingExcludes must include setup, authentication, and http');
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

function validateRegressionReasons(reasons, errors) {
  if (!Array.isArray(reasons)) {
    errors.push('regressionReasons must be an array');
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
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10) {
      errors.push(`${path}.reason must be a substantive non-empty explanation`);
    }
  }
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
      validateSample(
        sample,
        `${path}.samples[${index}]`,
        index,
        errors,
        allowDbwLinkedDurableDefects,
      );
    }
    if (workload.samples.length > 0 && workload.samples.every(canDeriveWorkloadSample)) {
      const derived = deriveWorkloadSummary(workload.samples);
      validateDerivedSummary(workload.summary, derived, `${path}.summary`, errors);
    } else if (workload.samples.length > 0) {
      errors.push(`${path}.summary cannot be derived from structurally malformed samples`);
    }
  }
}

function validateSample(sample, path, runIndex, errors, allowDbwLinkedDurableDefects) {
  validateMetrics(sample, path, errors);
  if (!isObject(sample)) {
    return;
  }
  if (sample.runIndex !== runIndex) {
    errors.push(`${path}.runIndex must equal ${runIndex}`);
  }
  requireMetric(sample, 'durationMs', path, errors);
  if (
    !Array.isArray(sample.latencySamplesMs) ||
    sample.latencySamplesMs.length !== STATE_WRITE_COMMANDS_PER_RUN
  ) {
    errors.push(`${path}.latencySamplesMs must contain exactly 700 command latencies`);
  }
  if (!Array.isArray(sample.commands) || sample.commands.length !== STATE_WRITE_COMMANDS_PER_RUN) {
    errors.push(`${path}.commands must contain exactly 700 raw command records`);
    return;
  }

  const commandIds = new Set();
  const commandsById = new Map();
  const kindCounts = new Map(MUTATION_MIX.map((kind) => [kind, 0]));
  const stackCounts = [0, 0];
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
  if (!sameNumericArray(sample.stackCommandCounts, stackCounts)) {
    errors.push(`${path}.stackCommandCounts does not match raw commands`);
  }

  const dbwFindings = Array.isArray(sample.correctness?.dbwFindings)
    ? sample.correctness.dbwFindings
    : [];
  const attempts = deriveAttempts(sample.attemptObservations, commandsById, path, errors);
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

function deriveAttempts(observations, commandsById, path, errors) {
  if (!Array.isArray(observations)) {
    errors.push(`${path}.attemptObservations must be an array`);
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
    if (!Number.isInteger(observation.attempt) || observation.attempt < 1) {
      errors.push(`${observationPath}.attempt must be a positive integer`);
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
  for (const [historyKey, history] of histories) {
    const separator = historyKey.indexOf('\u0000');
    const commandId = historyKey.slice(0, separator);
    const operationId = historyKey.slice(separator + 1);
    historiesByCommand.get(commandId)?.push({ operationId, history });
    for (const [index, observation] of history.entries()) {
      if (observation.attempt !== index + 1) {
        errors.push(
          `${path}: ${commandId}/${operationId} attempt numbers must be ordered and contiguous from 1`,
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

function deriveDurableCorrectness(
  sample,
  commandsById,
  dbwFindings,
  path,
  errors,
  allowDbwLinkedDurableDefects,
) {
  const receipts = sample.durable?.receiptCommandIds;
  const intents = sample.durable?.outboxIntents;
  const receiptIds = Array.isArray(receipts) ? receipts : [];
  const intentRecords = Array.isArray(intents) ? intents : [];
  if (!Array.isArray(receipts)) {
    errors.push(`${path}.durable.receiptCommandIds must be an array`);
  }
  if (!Array.isArray(intents)) {
    errors.push(`${path}.durable.outboxIntents must be an array`);
  }
  const canRetainBaselineDefect = allowDbwLinkedDurableDefects &&
    dbwFindings.length > 0 && dbwFindings.every(isValidDbwFinding);
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
  if (receiptSet.size !== receiptIds.length && !canRetainBaselineDefect) {
    errors.push(`${path}.durable receipt command IDs must be unique`);
  }
  const acceptedIds = acceptedCommands.map((command) => command.commandId).sort();
  if (!sameStringArray([...receiptSet].sort(), acceptedIds) && !canRetainBaselineDefect) {
    errors.push(`${path}.durable receipts must match accepted command IDs exactly`);
  }

  const intentIds = intentRecords.map((intent) => intent?.intentId);
  if (new Set(intentIds).size !== intentIds.length && !canRetainBaselineDefect) {
    errors.push(`${path}.durable outbox intent IDs must be unique`);
  }
  const expected = acceptedCommands.flatMap((command) =>
    (STATE_WRITE_MUTATION_CONTRACT[command.kind] ?? []).map((intentKind, index) =>
      `${command.commandId}:intent:${index}\u0000${command.commandId}\u0000${intentKind}`
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
    return `${intent?.intentId}\u0000${intent?.commandId}\u0000${intent?.intentKind}`;
  }).sort();
  if (!sameStringArray(actual, expected) && !canRetainBaselineDefect) {
    errors.push(`${path}.durable outbox intents do not match the mutation contract`);
  }
  const effectfulCommandCount =
    acceptedCommands.filter((command) =>
      (STATE_WRITE_MUTATION_CONTRACT[command.kind]?.length ?? 0) > 0
    )
      .length;
  return {
    receiptCount: receiptIds.length,
    effectfulCommandCount,
    requiredOutboxIntentCount: expected.length,
    outboxIntentCount: intentRecords.length,
  };
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
  if (!Array.isArray(findings)) {
    errors.push(`${path}.dbwFindings must be an array`);
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
    Array.isArray(sample.commands) &&
    sample.commands.every((command) =>
      isObject(command) && MUTATION_MIX.includes(command.kind) &&
      typeof command.commandId === 'string' &&
      ['accepted', 'exhausted'].includes(command.status) &&
      isNonNegativeNumber(command.latencyMs)
    ) &&
    Array.isArray(sample.attemptObservations) &&
    sample.attemptObservations.every((observation) =>
      isObject(observation) && typeof observation.commandId === 'string' &&
      typeof observation.operationId === 'string' &&
      Number.isInteger(observation.attempt) &&
      ['accepted', 'conflicted', 'exhausted'].includes(observation.outcome) &&
      typeof observation.terminal === 'boolean' &&
      typeof observation.source === 'string'
    ) &&
    isObject(sample.durable) &&
    Array.isArray(sample.durable.receiptCommandIds) &&
    Array.isArray(sample.durable.outboxIntents) &&
    isObject(sample.correctness) &&
    Array.isArray(sample.correctness.dbwFindings) &&
    isObject(sample.sql) &&
    isObject(sample.postgres) &&
    isObject(sample.timingsMs);
}

function deriveWorkloadSummary(samples) {
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
      receiptCount: sum(samples.map((sample) => sample.durable.receiptCommandIds.length)),
      effectfulCommandCount: sum(
        samples.map((sample) =>
          sample.commands.filter((command) =>
            command.status === 'accepted' &&
            STATE_WRITE_MUTATION_CONTRACT[command.kind].length > 0
          ).length
        ),
      ),
      requiredOutboxIntentCount: sum(samples.map((sample) =>
        sample.commands.reduce(
          (total, command) =>
            total + (
              command.status === 'accepted' ? STATE_WRITE_MUTATION_CONTRACT[command.kind].length : 0
            ),
          0,
        )
      )),
      outboxIntentCount: sum(samples.map((sample) => sample.durable.outboxIntents.length)),
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
  return new Map(artifact.workloads.map((workload) => [
    workload.name,
    deriveWorkloadSummary(workload.samples),
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
    typeof entry.reason === 'string' && entry.reason.trim().length > 0
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
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
