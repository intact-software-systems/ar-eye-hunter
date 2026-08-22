#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isValidPersistedResult, validateReceiptResultBindings } from './api-v1-state-write-result-binding.mjs';

export const STATE_WRITE_ARTIFACT_SCHEMA_VERSION = 'rallar.api-v1.state-write.v5';
export const STATE_WRITE_COMMANDS_PER_RUN = 700;

export const PRODUCTION_STATE_WRITE_MUTATION_CONTRACT = Object.freeze({
    'profile-instance': Object.freeze([
        'principal-state:snapshot',
        'principal-state:event',
        'principal-state:snapshot',
        'principal-state:event'
    ]),
    membership: Object.freeze(['group-presence-summary']),
    'presence-connect': Object.freeze(['group-presence-summary']),
    'presence-heartbeat': Object.freeze(['group-presence-summary']),
    'presence-disconnect': Object.freeze(['group-presence-summary']),
    config: Object.freeze(['group-presence-summary']),
    'topology-source': Object.freeze(['rtc-topology-recompute'])
});

const WORKLOADS = new Map([
    ['uncontended', { clients: 100, groups: 100, concurrency: 10 }],
    ['shared', { clients: 100, groups: 5, concurrency: 10 }],
    ['hot', { clients: 100, groups: 1, concurrency: 10 }]
]);
const MUTATION_MIX = Object.keys(PRODUCTION_STATE_WRITE_MUTATION_CONTRACT);
const TIMING_BUCKETS = ['read', 'compute', 'validate', 'write', 'transaction', 'outbox'];
const SQL_METRICS = ['statements', 'rowsRead', 'serializedResultBytes'];
const POSTGRES_METRICS = [
    'transactionDurationMs',
    'lockWaitMs',
    'cpuTimeMs',
    'sharedBufferHits',
    'sharedBufferReads',
    'walBytes'
];
const OUTCOME_METRICS = [
    'accepted',
    'conflicted',
    'transientRetries',
    'exhausted',
    'attempts',
    'attemptsPerAcceptedMutation'
];
const CORRECTNESS_METRICS = [
    'acceptedCommandCount',
    'receiptCount',
    'effectfulCommandCount',
    'requiredOutboxIntentCount',
    'outboxIntentCount'
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
    'outboxIntents'
];
const DBW_FINDING_PATTERN = /^DBW-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const REGRESSION_REASON_METRICS = new Set([
    'sql.statements',
    'sql.rowsRead',
    'sql.serializedResultBytes',
    'postgres.transactionDurationMs'
]);

const RESOURCE_REGRESSION_METRICS = [
    ['sql', 'statements'],
    ['sql', 'rowsRead'],
    ['sql', 'serializedResultBytes'],
    ['postgres', 'transactionDurationMs']
];

/**
 * These four are stochastic, not deterministic. The workloads contend
 * deliberately, so retry attempt counts vary with timing, and statement counts,
 * rows read, and transaction duration all follow attempt counts. An
 * order-balanced control on byte-identical code measured drift up to +2.7%,
 * scaling with contention: +0.2% on `uncontended` (100 groups), +1.6% on
 * `shared` (5), +2.7% on `hot` (1). They therefore share the tolerance already
 * used for latency and throughput rather than being compared for strict
 * increase, which no identical-code run could satisfy. Exceeding the band still
 * requires a recorded reason. Evidence: issue #157 and
 * `playground/rtc-design/baselines/2026-08-15-state-write-pooling-control-results.md`.
 */
export const RESOURCE_REGRESSION_RATIO = 0.05;

/**
 * The child structure policy suppresses findings from this comparator by exact
 * string equality, so both sides must build the message here rather than each
 * formatting its own copy.
 */
export function toStateWriteResourceRegressionMessage(input) {
    return (
        `${input.workload} median ${input.metric} regressed by more than ` +
        `${RESOURCE_REGRESSION_RATIO * 100}% without a recorded reason: ` +
        `baseline=${input.baselineMedian}, candidate=${input.candidateMedian}`
    );
}

export function validateStateWriteArtifact(artifact) {
    try {
        return validateStateWriteArtifactInternal(artifact);
    }
    catch (error) {
        return [
            `artifact contains malformed nested data that could not be derived safely: ${errorMessage(error)}`
        ];
    }
}

function validateStateWriteArtifactInternal(artifact) {
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
    validateFinalEvidenceSources(artifact.measurement, errors);

    if (!isDenseArray(artifact.workloads)) {
        errors.push('workloads must be a dense array');
        return errors;
    }
    const names = artifact.workloads.map((workload) => workload?.name);
    if (
        names.length !== WORKLOADS.size ||
        [...WORKLOADS.keys()].some((name) => names.filter((candidate) => candidate === name).length !== 1)
    ) {
        errors.push('workloads must contain uncontended, shared, and hot exactly once');
    }
    for (const [index, workload] of artifact.workloads.entries()) {
        validateWorkload(workload, artifact.measurement, `workloads[${index}]`, errors);
    }
    validateRegressionReasons(artifact.regressionReasons, errors);
    return errors;
}

export function compareStateWriteArtifacts(baseline, candidate) {
    try {
        return compareStateWriteArtifactsInternal(baseline, candidate);
    }
    catch (error) {
        return [
            `comparison contains malformed nested data that could not be derived safely: ${errorMessage(error)}`
        ];
    }
}

function compareStateWriteArtifactsInternal(baseline, candidate) {
    const baselineValidation = validateStateWriteArtifact(baseline);
    const candidateValidation = validateStateWriteArtifact(candidate);
    const errors = [
        ...baselineValidation.map((error) => `baseline: ${error}`),
        ...candidateValidation.map((error) => `candidate: ${error}`)
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
        0.05
    );
    compareMaximumRegression(
        errors,
        'uncontended latency p99',
        uncontendedBaseline.latencyMs.p99,
        uncontendedCandidate.latencyMs.p99,
        0.05
    );

    for (const name of ['shared', 'hot']) {
        compareMinimumThroughput(
            errors,
            `${name} throughput`,
            baselineByName.get(name).throughputPerSecond,
            candidateByName.get(name).throughputPerSecond,
            0.05
        );
    }

    for (const name of WORKLOADS.keys()) {
        const baselineWorkload = baselineByName.get(name);
        const candidateWorkload = candidateByName.get(name);
        for (const [container, metric] of RESOURCE_REGRESSION_METRICS) {
            const baselineMedian = baselineWorkload[container][metric];
            const candidateMedian = candidateWorkload[container][metric];
            if (
                candidateMedian > baselineMedian * (1 + RESOURCE_REGRESSION_RATIO) &&
                !hasRecordedReason(candidate, name, `${container}.${metric}`)
            ) {
                errors.push(
                    toStateWriteResourceRegressionMessage({
                        workload: name,
                        metric: `${container}.${metric}`,
                        baselineMedian,
                        candidateMedian
                    })
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
                `candidate=${candidateHotExhausted}`
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
        for (const failure of correctnessFailures(baselineCorrectness)) {
            errors.push(`${name} baseline correctness failed: ${failure}`);
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
            'measurement.mutationTimingExcludes must be a dense array including setup, http, and either legacy authentication or auth-session insertion'
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
    if (
        measurement?.counterSources?.attempts !==
            'resource_inbox.release.telemetry+app_inbox.ri_attempts reconciliation'
    ) {
        errors.push(
            'measurement.counterSources.attempts must equal ' +
                'resource_inbox.release.telemetry+app_inbox.ri_attempts reconciliation'
        );
    }
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

function validateWorkload(workload, measurement, path, errors) {
    if (!isObject(workload)) {
        errors.push(`${path} must be an object`);
        return;
    }
    const expectedScale = WORKLOADS.get(workload.name);
    if (!expectedScale) {
        errors.push(`${path}.name is not a supported workload`);
    }
    else {
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
            `${path}.samples must contain exactly measurement.measuredRuns entries as a dense array`
        );
    }
    else {
        for (const [index, sample] of workload.samples.entries()) {
            validateSample(sample, `${path}.samples[${index}]`, index, errors);
        }
        if (workload.samples.length > 0 && workload.samples.every(canDeriveWorkloadSample)) {
            const derived = deriveWorkloadSummary(workload.samples);
            validateDerivedSummary(workload.summary, derived, `${path}.summary`, errors);
        }
        else if (workload.samples.length > 0) {
            errors.push(`${path}.summary cannot be derived from structurally malformed samples`);
        }
    }
}

function validateSample(sample, path, runIndex, errors) {
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
            `${path}.latencySamplesMs must contain exactly 700 command latencies as a dense array`
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
        }
        else if (rawCommandPrefix === undefined) {
            rawCommandPrefix = identity.prefix;
        }
        else if (identity.prefix !== rawCommandPrefix) {
            errors.push(`${commandPath}.command ID must share the sample command prefix`);
        }
        if (!MUTATION_MIX.includes(command.kind)) {
            errors.push(`${commandPath}.kind is not in the mutation contract`);
        }
        else {
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
        }
        else {
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
    }
    else if (!sameNumericArray(sample.stackCommandCounts, stackCounts)) {
        errors.push(`${path}.stackCommandCounts does not match raw commands`);
    }

    const attempts = deriveAttempts(
        sample.attemptObservations,
        commandsById,
        path,
        errors,
        sample.durableEvidence?.appInbox
    );
    compareNumber(
        sample.outcomes?.attempts,
        attempts.attempts,
        `${path}.outcomes.attempts`,
        errors,
        'attempt observations'
    );
    compareNumber(
        sample.outcomes?.conflicted,
        attempts.conflicted,
        `${path}.outcomes.conflicted`,
        errors,
        'attempt observations'
    );
    compareNumber(
        sample.outcomes?.transientRetries,
        attempts.transientRetries,
        `${path}.outcomes.transientRetries`,
        errors,
        'attempt observations'
    );
    compareNumber(
        sample.outcomes?.exhausted,
        attempts.exhausted,
        `${path}.outcomes.exhausted`,
        errors,
        'attempt observations'
    );
    compareNumber(
        sample.outcomes?.attemptsPerAcceptedMutation,
        attempts.accepted === 0 ? 0 : attempts.attempts / attempts.accepted,
        `${path}.outcomes.attemptsPerAcceptedMutation`,
        errors,
        'attempt observations'
    );
    const durable = deriveFinalDurableCorrectness(sample, commandsById, path, errors);
    compareNumber(
        sample.correctness?.acceptedCommandCount,
        attempts.accepted,
        `${path}.correctness.acceptedCommandCount`,
        errors,
        'raw commands'
    );
    compareNumber(
        sample.correctness?.receiptCount,
        durable.receiptCount,
        `${path}.correctness.receiptCount`,
        errors,
        'durable records'
    );
    compareNumber(
        sample.correctness?.effectfulCommandCount,
        durable.effectfulCommandCount,
        `${path}.correctness.effectfulCommandCount`,
        errors,
        'mutation contract'
    );
    compareNumber(
        sample.correctness?.requiredOutboxIntentCount,
        durable.requiredOutboxIntentCount,
        `${path}.correctness.requiredOutboxIntentCount`,
        errors,
        'mutation contract'
    );
    compareNumber(
        sample.correctness?.outboxIntentCount,
        durable.outboxIntentCount,
        `${path}.correctness.outboxIntentCount`,
        errors,
        'durable records'
    );
    compareNumber(
        sample.outcomes?.accepted,
        attempts.accepted,
        `${path}.outcomes.accepted`,
        errors,
        'raw commands'
    );

    const latency = percentileSummary(sample.commands.map((command) => command.latencyMs));
    for (const metric of ['p50', 'p95', 'p99']) {
        compareNumber(
            sample.latencyMs?.[metric],
            latency[metric],
            `${path}.latencyMs.${metric}`,
            errors,
            'raw samples'
        );
    }
    compareNumber(
        sample.throughputPerSecond,
        attempts.accepted / (sample.durationMs / 1_000),
        `${path}.throughputPerSecond`,
        errors,
        'raw commands'
    );
}

function deriveAttempts(
    observations,
    commandsById,
    path,
    errors,
    appInboxEvidence
) {
    if (!isDenseArray(observations)) {
        errors.push(`${path}.attemptObservations must be a dense array`);
        return { attempts: 0, conflicted: 0, transientRetries: 0, exhausted: 0, accepted: 0 };
    }
    const histories = new Map();
    let conflicted = 0;
    let transientRetries = 0;
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
        if (!['accepted', 'conflicted', 'transient-retry', 'exhausted'].includes(observation.outcome)) {
            errors.push(`${observationPath}.outcome is invalid`);
        }
        if (typeof observation.source !== 'string' || observation.source.trim().length === 0) {
            errors.push(`${observationPath}.source must disclose a timing-sink source`);
        }
        validateAttemptFailure(observation, observationPath, errors);
        const terminalOutcome = observation.outcome === 'accepted' ||
            observation.outcome === 'exhausted';
        if (observation.terminal !== terminalOutcome) {
            errors.push(
                `${observationPath}.terminal must be false for conflicts and true for accepted/exhausted`
            );
        }
        const historyKey = `${observation.commandId}\u0000${observation.operationId}`;
        const history = histories.get(historyKey) ?? [];
        history.push({ ...observation, index });
        histories.set(historyKey, history);
        conflicted += observation.outcome === 'conflicted' ? 1 : 0;
        transientRetries += observation.outcome === 'transient-retry' ? 1 : 0;
    }

    const historiesByCommand = new Map(
        [...commandsById.keys()].map((commandId) => [commandId, []])
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
                'state-write-command-envelope.prerequisite-exhausted:'
            );
        if (prerequisiteHistory) {
            errors.push(
                `${path}: ${commandId}/${operationId} service-local prerequisite evidence is forbidden`
            );
        }
        const expectedFirstAttempt = 1;
        if (firstAttempt !== expectedFirstAttempt) {
            errors.push(
                `${path}: ${commandId}/${operationId} attempts must start at ${expectedFirstAttempt}`
            );
        }
        if (!prerequisiteHistory) {
            for (const observation of history) {
                if (
                    observation.source !== 'resource_inbox.release.telemetry' ||
                    !isNonNegativeNumber(observation.retryDelayMs) ||
                    !isNonNegativeNumber(observation.dueAgeMs) ||
                    !['fast', 'fairness', 'timeout'].includes(observation.selectedLane)
                ) {
                    errors.push(
                        `${path}: ${commandId}/${operationId} production attempt source is not ` +
                            'production ResourceInbox release telemetry'
                    );
                    break;
                }
            }
        }
        for (const [index, observation] of history.entries()) {
            if (observation.attempt !== firstAttempt + index) {
                errors.push(
                    `${path}: ${commandId}/${operationId} attempt numbers must be ordered and contiguous`
                );
                break;
            }
        }
        if (!prerequisiteHistory) {
            const durableAttempt = Array.isArray(appInboxEvidence)
                ? appInboxEvidence.find((entry) =>
                    entry?.commandId === commandId &&
                    entry?.operationId === operationId
                )
                : undefined;
            if (
                !durableAttempt || durableAttempt.attempts !== history.length ||
                durableAttempt.attempts !== history.at(-1)?.attempt
            ) {
                errors.push(
                    `${path}: ${commandId}/${operationId} observed attempts must reconcile exactly ` +
                        'to durable AppInbox attempts'
                );
            }
        }
        const terminals = history.filter((observation) => observation.terminal === true);
        if (terminals.length !== 1) {
            errors.push(`${path}: ${commandId}/${operationId} must have exactly one terminal outcome`);
        }
        else if (history.at(-1) !== terminals[0]) {
            errors.push(`${path}: ${commandId}/${operationId} terminal outcome must be last`);
        }
        if (
            history.slice(0, -1).some((observation) => !['conflicted', 'transient-retry'].includes(observation.outcome))
        ) {
            errors.push(`${path}: ${commandId}/${operationId} only retries may precede a terminal`);
        }
        if (
            history.slice(0, -1).some((observation) =>
                !isNonNegativeNumber(observation.retryDelayMs) || observation.retryDelayMs <= 0
            )
        ) {
            errors.push(
                `${path}: ${commandId}/${operationId} nonterminal retryDelayMs must be positive`
            );
        }
        const terminal = terminals[0];
        if (terminal?.outcome === 'exhausted') {
            const prerequisiteTerminal = history.length === 1 &&
                terminal.source.startsWith(
                    'state-write-command-envelope.prerequisite-exhausted:'
                );
            const productionExhaustion = terminal.source === 'resource_inbox.release.telemetry' &&
                history.slice(0, -1).some((observation) =>
                    observation.outcome === 'conflicted' &&
                    observation.source === 'resource_inbox.release.telemetry'
                );
            if (!prerequisiteTerminal && !productionExhaustion) {
                errors.push(
                    `${path}: ${commandId}/${operationId} production exhaustion must retain ` +
                        'a preceding production mutation.conflict observation'
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
                `${path}: ${commandId} status does not match its coherent terminal attempt outcome`
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
    return { attempts: observations.length, conflicted, transientRetries, exhausted, accepted };
}

const OPTIMISTIC_CONFLICT_CODES = new Set([
    'app-inbox-reservation-conflict',
    'resource-inbox-lost-reservation',
    'runtime-state-write-conflict',
    'state-snapshot-read-conflict',
    'group-topology-commit-conflict'
]);
const OPTIMISTIC_CONFLICT_NAMES = new Set([
    'RuntimeStateWriteConflictError',
    'CrdtMutationConflictError',
    'StateSnapshotRevisionConflictError',
    'GroupTopologyCommitConflictError',
    'AppInboxReservationConflictError'
]);

function validateAttemptFailure(observation, path, errors) {
    const failure = observation.failure;
    if (!isObject(failure) || !['none', 'retryable', 'non-retryable'].includes(failure.kind)) {
        errors.push(`${path}.failure must carry a typed release failure`);
        return;
    }
    if (failure.kind === 'none') {
        if (Object.keys(failure).length !== 1 || observation.outcome !== 'accepted') {
            errors.push(`${path}.failure none is valid only for an accepted release`);
        }
        return;
    }
    if (
        Object.keys(failure).length !== 3 || typeof failure.code !== 'string' ||
        failure.code.length === 0 || typeof failure.name !== 'string' || failure.name.length === 0
    ) {
        errors.push(`${path}.failure typed identity is malformed`);
        return;
    }
    const conflict = failure.kind === 'retryable' &&
        (OPTIMISTIC_CONFLICT_CODES.has(failure.code) || OPTIMISTIC_CONFLICT_NAMES.has(failure.name));
    if ((observation.outcome === 'conflicted') !== conflict) {
        errors.push(`${path}.outcome must classify only recognized optimistic conflicts`);
    }
    if (
        observation.outcome === 'transient-retry' &&
        (failure.kind !== 'retryable' || conflict)
    ) {
        errors.push(`${path}.transient-retry must preserve a non-conflict retryable failure`);
    }
}

function parseRawCommandClientIdentity(command) {
    if (
        !isObject(command) || typeof command.commandId !== 'string' ||
        typeof command.kind !== 'string'
    ) {
        return undefined;
    }
    const marker = `:${command.kind}:`;
    const markerIndex = command.commandId.lastIndexOf(marker);
    if (markerIndex <= 0) {
        return undefined;
    }
    const prefix = command.commandId.slice(0, markerIndex);
    const clientOrdinal = command.commandId.slice(markerIndex + marker.length);
    if (
        !/^\d+$/.test(clientOrdinal) ||
        command.commandId !== `${prefix}${marker}${clientOrdinal}`
    ) {
        return undefined;
    }
    return { prefix, clientOrdinal };
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
    const acceptedCommands = [...commandsById.values()].filter((command) => command.status === 'accepted');
    const receiptIds = receipts.map((receipt, index) => {
        if (
            !isObject(receipt) || typeof receipt.commandId !== 'string' ||
            !commandsById.has(receipt.commandId) || !isDenseStringArray(receipt.receiptIds) ||
            !isDenseStringArray(receipt.outboxIds) ||
            !isDenseArray(receipt.resultBindings) ||
            !['logical-msg-id', 'physical-resource-id'].includes(receipt.identityKind)
        ) {
            errors.push(`${path}.durableEvidence.receipts[${index}] is malformed or unlinked`);
        }
        validateReceiptResultBindings(receipt, commandsById.get(receipt?.commandId), path, index, errors);
        if (
            isDenseStringArray(receipt?.receiptIds) &&
            new Set(receipt.receiptIds).size !== receipt.receiptIds.length
        ) {
            errors.push(`${path}.durableEvidence.receipts[${index}] receipt IDs must be unique`);
        }
        if (
            isDenseStringArray(receipt?.outboxIds) &&
            new Set(receipt.outboxIds).size !== receipt.outboxIds.length
        ) {
            errors.push(`${path}.durableEvidence.receipts[${index}] outbox IDs must be unique`);
        }
        return receipt?.commandId;
    });
    if (!sameStringArray(receiptIds.toSorted(), acceptedCommands.map((entry) => entry.commandId).toSorted())) {
        errors.push(`${path}.durableEvidence receipts must match accepted command IDs exactly`);
    }
    const receiptsByCommand = new Map(receipts.map((receipt) => [receipt?.commandId, receipt]));
    validateAppInboxEvidence(appInbox, commandsById, receiptsByCommand, path, errors);
    const effectIds = new Set();
    const actualEffects = resourceOutbox.map((effect, index) => {
        if (
            !isObject(effect) || typeof effect.effectId !== 'string' || effect.effectId.length === 0 ||
            typeof effect.commandId !== 'string' || !commandsById.has(effect.commandId) ||
            typeof effect.effectKind !== 'string' || effect.effectKind.length === 0 ||
            typeof effect.resourceId !== 'string' || effect.resourceId.length === 0 ||
            typeof effect.outboxId !== 'string' || effect.outboxId.length === 0 ||
            !['APP_OUTBOX', 'WS_OUTBOX'].includes(effect.typeId) ||
            typeof effect.topicId !== 'string' || effect.topicId.length === 0
        ) {
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
    for (const receipt of receipts) {
        const exactEffects = resourceOutbox.filter((effect) => effect?.commandId === receipt?.commandId).map((effect) =>
            effect.effectId
        ).toSorted();
        if (!sameStringArray((receipt?.outboxIds ?? []).toSorted(), exactEffects)) {
            errors.push(
                `${path}.durableEvidence receipt outbox IDs must match exact ResourceInbox effects`
            );
        }
    }
    for (const entry of appInbox) {
        const embedded = embeddedResultReceipt(entry);
        if (embedded === undefined) {
            continue;
        }
        const authoritative = receipts.find((receipt) => receipt?.commandId === entry?.commandId);
        if (
            !authoritative || !authoritative.receiptIds.includes(embedded.commandId) ||
            !sameStringArray(authoritative.outboxIds.toSorted(), embedded.outboxIds.toSorted())
        ) {
            errors.push(
                `${path}.durableEvidence embedded result receipt must match authoritative receipt and effects`
            );
        }
    }
    const atomicFailures = deriveAtomicCompletionFailures(
        acceptedCommands,
        appInbox,
        receipts,
        resourceOutbox
    );
    compareNumber(
        evidence.atomicCompletionFailures,
        atomicFailures,
        `${path}.durableEvidence.atomicCompletionFailures`,
        errors,
        'same-observation durable completion'
    );
    compareNumber(
        sample.correctness?.atomicCompletionFailures,
        atomicFailures,
        `${path}.correctness.atomicCompletionFailures`,
        errors,
        'same-observation durable completion'
    );
    return {
        receiptCount: receipts.length,
        effectfulCommandCount:
            acceptedCommands.filter((command) => PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].length > 0)
                .length,
        requiredOutboxIntentCount: expectedEffects.length,
        outboxIntentCount: resourceOutbox.length
    };
}

function validateAppInboxEvidence(entries, commandsById, receiptsByCommand, path, errors) {
    const identities = new Set();
    for (const [index, entry] of entries.entries()) {
        if (
            !isObject(entry) || typeof entry.commandId !== 'string' ||
            !commandsById.has(entry.commandId) || typeof entry.operationId !== 'string' ||
            entry.operationId.length === 0 || typeof entry.resourceId !== 'string' ||
            entry.resourceId.length === 0 || entry.status !== 'COMPLETED' ||
            entry.resultStatus !== 'COMPLETED' || !Number.isInteger(entry.attempts) ||
            entry.attempts < 1 || !isNonNegativeNumber(entry.retryDelayMs) ||
            !isNonNegativeNumber(entry.dueAgeMs) ||
            !['fast', 'fairness', 'timeout'].includes(entry.selectedLane) ||
            !isNonNegativeNumber(entry.transactionDurationMs)
        ) {
            errors.push(`${path}.durableEvidence.appInbox[${index}] is malformed or incomplete`);
        }
        const binding = receiptsByCommand.get(entry?.commandId)?.resultBindings?.find(
            (candidate) => candidate?.operationId === entry?.operationId
        );
        if (!isValidPersistedResult(entry, commandsById.get(entry?.commandId), binding)) {
            errors.push(
                `${path}.durableEvidence.appInbox[${index}] persisted durable result is malformed`
            );
        }
        const identity = `${entry?.commandId}\u0000${entry?.operationId}`;
        if (identities.has(identity)) {
            errors.push(`${path}.durableEvidence AppInbox command/operation identities must be unique`);
        }
        identities.add(identity);
    }
}

function embeddedResultReceipt(entry) {
    if (!isObject(entry?.durableResult)) {
        return undefined;
    }
    const result = entry.durableResult;
    const receipt = entry.commandType?.startsWith('GROUP_PRESENCE_')
        ? result
        : entry.commandType?.startsWith('TOPOLOGY_')
        ? result.receipt
        : undefined;
    return isObject(receipt) && typeof receipt.commandId === 'string' &&
            isDenseStringArray(receipt.outboxIds)
        ? { commandId: receipt.commandId, outboxIds: receipt.outboxIds }
        : undefined;
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
        outboxIntentCount: 0
    };
}

function isDenseStringArray(value) {
    return isDenseArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
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
            ['accepted', 'conflicted', 'transient-retry', 'exhausted'].includes(observation.outcome) &&
            typeof observation.terminal === 'boolean' &&
            typeof observation.source === 'string'
        ) &&
        isObject(sample.durableEvidence) &&
        isDenseArray(sample.durableEvidence.appInbox) &&
        isDenseArray(sample.durableEvidence.receipts) &&
        isDenseArray(sample.durableEvidence.resourceOutbox) &&
        isDenseArray(sample.durableEvidence.intermediateMutationIntents) &&
        isObject(sample.correctness) &&
        isDenseArray(sample.correctness.dbwFindings) &&
        isObject(sample.sql) &&
        isObject(sample.postgres) &&
        isObject(sample.timingsMs);
}

function deriveWorkloadSummary(samples) {
    const latencySamples = samples.flatMap((sample) => sample.commands.map((command) => command.latencyMs));
    const accepted = sum(
        samples.map((sample) => sample.commands.filter((command) => command.status === 'accepted').length)
    );
    const durationMs = sum(samples.map((sample) => sample.durationMs));
    const attemptMetrics = samples.map((sample) => ({
        attempts: sample.attemptObservations.length,
        conflicted: sample.attemptObservations.filter((entry) => entry.outcome === 'conflicted').length,
        transientRetries: sample.attemptObservations.filter((entry) => entry.outcome === 'transient-retry').length,
        exhausted: sample.commands.filter((command) => command.status === 'exhausted').length
    }));
    const attempts = sum(attemptMetrics.map((entry) => entry.attempts));
    const dbwFindings = [...new Set(samples.flatMap((sample) => sample.correctness.dbwFindings))];
    return {
        latencyMs: percentileSummary(latencySamples),
        throughputPerSecond: accepted / (durationMs / 1_000),
        outcomes: {
            accepted,
            conflicted: sum(attemptMetrics.map((entry) => entry.conflicted)),
            transientRetries: sum(attemptMetrics.map((entry) => entry.transientRetries)),
            exhausted: sum(attemptMetrics.map((entry) => entry.exhausted)),
            attempts,
            attemptsPerAcceptedMutation: attempts / accepted
        },
        sql: medianObject(samples.map((sample) => sample.sql)),
        postgres: medianObject(samples.map((sample) => sample.postgres)),
        timingsMs: medianObject(samples.map((sample) => sample.timingsMs)),
        correctness: {
            acceptedCommandCount: accepted,
            receiptCount: sum(samples.map((sample) => sample.durableEvidence.receipts.length)),
            effectfulCommandCount: sum(
                samples.map((sample) =>
                    sample.commands.filter((command) =>
                        command.status === 'accepted' &&
                        PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].length > 0
                    ).length
                )
            ),
            requiredOutboxIntentCount: sum(samples.map((sample) =>
                sample.commands.reduce(
                    (total, command) =>
                        total + (
                            command.status === 'accepted'
                                ? PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].length
                                : 0
                        ),
                    0
                )
            )),
            outboxIntentCount: sum(samples.map((sample) => sample.durableEvidence.resourceOutbox.length)),
            atomicCompletionFailures: sum(
                samples.map((sample) => sample.durableEvidence.atomicCompletionFailures ?? 0)
            ),
            dbwFindings
        }
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
            'raw samples'
        );
    }
    compareNumber(
        summary?.throughputPerSecond,
        derived.throughputPerSecond,
        `${path}.throughputPerSecond`,
        errors,
        'raw samples'
    );
    for (const metric of OUTCOME_METRICS) {
        compareNumber(
            summary?.outcomes?.[metric],
            derived.outcomes[metric],
            `${path}.outcomes.${metric}`,
            errors,
            'raw samples'
        );
    }
    for (const metric of SQL_METRICS) {
        compareNumber(
            summary?.sql?.[metric],
            derived.sql[metric],
            `${path}.sql.${metric}`,
            errors,
            'sample median'
        );
    }
    for (const metric of POSTGRES_METRICS) {
        compareNumber(
            summary?.postgres?.[metric],
            derived.postgres[metric],
            `${path}.postgres.${metric}`,
            errors,
            'sample median'
        );
    }
    for (const metric of TIMING_BUCKETS) {
        compareNumber(
            summary?.timingsMs?.[metric],
            derived.timingsMs[metric],
            `${path}.timingsMs.${metric}`,
            errors,
            'sample median'
        );
    }
    for (const metric of CORRECTNESS_METRICS) {
        compareNumber(
            summary?.correctness?.[metric],
            derived.correctness[metric],
            `${path}.correctness.${metric}`,
            errors,
            'raw durable samples'
        );
    }
    if (Object.hasOwn(derived.correctness, 'atomicCompletionFailures')) {
        compareNumber(
            summary?.correctness?.atomicCompletionFailures,
            derived.correctness.atomicCompletionFailures,
            `${path}.correctness.atomicCompletionFailures`,
            errors,
            'raw durable samples'
        );
    }
    if (
        !sameStringArray(
            [...(summary?.correctness?.dbwFindings ?? [])].sort(),
            [...derived.correctness.dbwFindings].sort()
        )
    ) {
        errors.push(`${path}.correctness.dbwFindings does not match raw samples`);
    }
}

function derivedWorkloads(artifact) {
    return new Map(artifact.workloads.map((workload) => [
        workload.name,
        deriveWorkloadSummary(workload.samples)
    ]));
}

function correctnessFailures(correctness) {
    const failures = [];
    if (correctness.acceptedCommandCount !== correctness.receiptCount) {
        failures.push(
            `accepted commands (${correctness.acceptedCommandCount}) != ` +
                `receipts (${correctness.receiptCount})`
        );
    }
    if (correctness.requiredOutboxIntentCount !== correctness.outboxIntentCount) {
        failures.push(
            `required outbox intents (${correctness.requiredOutboxIntentCount}) != ` +
                `actual intents (${correctness.outboxIntentCount})`
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
        p99: percentile(values, 0.99)
    };
}

function percentile(values, ratio) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.ceil(sorted.length * ratio) - 1];
}

function medianObject(values) {
    return Object.fromEntries(
        Object.keys(values[0]).map((key) => [key, median(values.map((value) => value[key]))])
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
            `${label} regressed by more than ${ratio * 100}%: baseline=${baseline}, candidate=${candidate}`
        );
    }
}

function compareMinimumThroughput(errors, label, baseline, candidate, ratio) {
    if (candidate < baseline * (1 - ratio)) {
        errors.push(
            `${label} regressed by more than ${ratio * 100}%: baseline=${baseline}, candidate=${candidate}`
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
        readArtifact(candidatePath)
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
