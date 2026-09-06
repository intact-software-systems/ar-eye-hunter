#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
    compareNumber,
    isDenseArray,
    isNonNegativeNumber,
    isObject,
    requireMetric,
    sameNumericArray,
    sameStringArray
} from './api-v1-state-write-artifact-validation.mjs';
import {
    PRODUCTION_STATE_WRITE_MUTATION_CONTRACT,
    requiredStateWriteOutboxCount
} from './api-v1-state-write-outbox-contract.mjs';
import { deriveAttempts } from './validate-state-write-attempt-evidence.mjs';
import { deriveFinalDurableCorrectness } from './validate-state-write-durable-evidence.mjs';

export const STATE_WRITE_ARTIFACT_SCHEMA_VERSION = 'rallar.api-v1.state-write.v6';
export const STATE_WRITE_COMMANDS_PER_RUN = 700;

const WORKLOADS = new Map([
    ['uncontended', { clients: 100, groups: 100, concurrency: 10 }],
    ['shared', { clients: 100, groups: 5, concurrency: 10 }],
    ['hot', { clients: 100, groups: 1, concurrency: 10 }]
]);
const MUTATION_MIX = Object.keys(PRODUCTION_STATE_WRITE_MUTATION_CONTRACT);
const TIMING_BUCKETS = [
    'read',
    'compute',
    'validate',
    'write',
    'transaction',
    'outbox'
];
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
const METRIC_GROUPS = [
    {
        container: 'latencyMs',
        metrics: ['p50', 'p95', 'p99'],
        source: 'raw samples'
    },
    { container: 'outcomes', metrics: OUTCOME_METRICS, source: 'raw samples' },
    { container: 'sql', metrics: SQL_METRICS, source: 'sample median' },
    {
        container: 'postgres',
        metrics: POSTGRES_METRICS,
        source: 'sample median'
    },
    {
        container: 'timingsMs',
        metrics: TIMING_BUCKETS,
        source: 'sample median'
    },
    {
        container: 'correctness',
        metrics: CORRECTNESS_METRICS,
        source: 'raw durable samples'
    }
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
    if (
        typeof artifact.gitCommit !== 'string' ||
        !/^[0-9a-f]{7,40}$/i.test(artifact.gitCommit)
    ) {
        errors.push('gitCommit must be a 7-40 character hexadecimal commit');
    }
    if (artifact.backend !== 'postgres') {
        errors.push('backend must equal postgres');
    }
    if (
        typeof artifact.generatedAt !== 'string' ||
        !Number.isFinite(Date.parse(artifact.generatedAt))
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
        errors.push(
            'workloads must contain uncontended, shared, and hot exactly once'
        );
    }
    for (const [index, workload] of artifact.workloads.entries()) {
        validateWorkload({
            workload: workload,
            measurement: artifact.measurement,
            path: `workloads[${index}]`,
            errors: errors
        });
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
    compareMaximumRegression({
        errors: errors,
        label: 'uncontended latency p95',
        baseline: uncontendedBaseline.latencyMs.p95,
        candidate: uncontendedCandidate.latencyMs.p95,
        ratio: 0.05
    });
    compareMaximumRegression({
        errors: errors,
        label: 'uncontended latency p99',
        baseline: uncontendedBaseline.latencyMs.p99,
        candidate: uncontendedCandidate.latencyMs.p99,
        ratio: 0.05
    });

    for (const name of ['shared', 'hot']) {
        compareMinimumThroughput({
            errors: errors,
            label: `${name} throughput`,
            baseline: baselineByName.get(name).throughputPerSecond,
            candidate: candidateByName.get(name).throughputPerSecond,
            ratio: 0.05
        });
    }

    compareResourceAndExhaustionMetrics({
        baselineByName,
        candidateByName,
        candidate,
        errors
    });

    return errors;
}

function compareResourceAndExhaustionMetrics(
    { baselineByName, candidateByName, candidate, errors }
) {
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
            errors.push(
                `${name} retry exhaustion must remain zero; received ${exhausted}`
            );
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
            workload.samples.length > 0 &&
            workload.samples.every(canDeriveWorkloadSample)
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
    if (
        !Number.isInteger(measurement.measuredRuns) || measurement.measuredRuns < 3
    ) {
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
            errors.push(
                `measurement.counterSources.${source} must be a non-empty disclosure`
            );
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
            errors.push(
                `${path}.reason must contain at least 10 non-whitespace characters`
            );
        }
    }
}

export function isSubstantiveRegressionReason(value) {
    return typeof value === 'string' && value.replaceAll(/\s/g, '').length >= 10;
}

/**
 * @typedef {{ workload: unknown, measurement: unknown, path: string, errors: string[] }} ValidateWorkloadInput
 * @param {ValidateWorkloadInput} input
 */
function validateWorkload({ workload, measurement, path, errors }) {
    if (!isObject(workload)) {
        errors.push(`${path} must be an object`);
        return;
    }
    validateWorkloadScale(workload, path, errors);
    if (
        workload.warmupRuns !== 1 || workload.warmupRuns !== measurement?.warmupRuns
    ) {
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
            validateSample({
                sample: sample,
                path: `${path}.samples[${index}]`,
                runIndex: index,
                errors: errors
            });
        }
        if (
            workload.samples.length > 0 &&
            workload.samples.every(canDeriveWorkloadSample)
        ) {
            const derived = deriveWorkloadSummary(workload.samples);
            validateDerivedSummary({
                summary: workload.summary,
                derived: derived,
                path: `${path}.summary`,
                errors: errors
            });
        }
        else if (workload.samples.length > 0) {
            errors.push(
                `${path}.summary cannot be derived from structurally malformed samples`
            );
        }
    }
}

function validateWorkloadScale(workload, path, errors) {
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
        errors.push(
            `${path}.mutationMix must be a dense exact deterministic mutation mix`
        );
    }
}

/**
 * @typedef {{ sample: unknown, path: string, runIndex: number, errors: string[] }} ValidateSampleInput
 * @param {ValidateSampleInput} input
 */
function validateSample({ sample, path, runIndex, errors }) {
    validateMetrics(sample, path, errors);
    if (!isObject(sample)) {
        return;
    }
    if (sample.runIndex !== runIndex) {
        errors.push(`${path}.runIndex must equal ${runIndex}`);
    }
    requireMetric({
        container: sample,
        metric: 'durationMs',
        path: path,
        errors: errors
    });
    if (!isDenseArray(sample.latencySamplesMs, STATE_WRITE_COMMANDS_PER_RUN)) {
        errors.push(
            `${path}.latencySamplesMs must contain exactly 700 command latencies as a dense array`
        );
    }
    if (!isDenseArray(sample.commands, STATE_WRITE_COMMANDS_PER_RUN)) {
        errors.push(
            `${path}.commands must be a dense array of exactly 700 raw command records`
        );
        return;
    }
    const commandsById = validateSampleCommands(sample, path, errors);
    const attempts = deriveAttempts({
        observations: sample.attemptObservations,
        commandsById: commandsById,
        path: path,
        errors: errors,
        appInboxEvidence: sample.durableEvidence?.appInbox
    });
    const durable = deriveFinalDurableCorrectness({
        sample: sample,
        commandsById: commandsById,
        path: path,
        errors: errors
    });
    validateSampleOutcomeMetrics({ sample, attempts, path, errors });
    validateSampleDurableMetrics({ sample, attempts, durable, path, errors });
    validateSampleLatency({ sample, attempts, path, errors });
}

function validateSampleCommands(sample, path, errors) {
    const commandsById = new Map();
    let rawCommandPrefix;
    for (const [index, command] of sample.commands.entries()) {
        if (
            !isObject(command) || typeof command.commandId !== 'string' ||
            command.commandId.length === 0
        ) {
            errors.push(`${path}.commands[${index}].commandId must be non-empty`);
            continue;
        }
        if (commandsById.has(command.commandId)) {
            errors.push(`${path}.command IDs must be unique`);
        }
        commandsById.set(command.commandId, command);
        rawCommandPrefix = validateRawCommandRecord({
            sample,
            command,
            index,
            rawCommandPrefix,
            path,
            errors
        });
    }
    for (const kind of MUTATION_MIX) {
        if (
            sample.commands.filter((command) => command?.kind === kind).length !== 100
        ) {
            errors.push(`${path}.commands must contain exactly 100 ${kind} commands`);
        }
    }
    const stackCounts = [0, 1].map((index) =>
        [...commandsById.values()].filter((command) => command.stackIndex === index)
            .length
    );
    if (stackCounts.some((count) => count === 0)) {
        errors.push(
            `${path}: both independent service stacks must execute commands`
        );
    }
    if (!isDenseArray(sample.stackCommandCounts, stackCounts.length)) {
        errors.push(
            `${path}.stackCommandCounts must be a dense array of two finite numbers`
        );
    }
    else if (!sameNumericArray(sample.stackCommandCounts, stackCounts)) {
        errors.push(`${path}.stackCommandCounts does not match raw commands`);
    }
    return commandsById;
}

function validateRawCommandRecord(
    { sample, command, index, rawCommandPrefix, path, errors }
) {
    const commandPath = `${path}.commands[${index}]`;
    if (command.kind !== MUTATION_MIX[Math.floor(index / 100)]) {
        errors.push(
            `${commandPath}.kind must preserve canonical raw mutation slot order`
        );
    }
    const identity = parseRawCommandClientIdentity(command);
    if (
        identity === undefined || identity.clientOrdinal !== String(index % 100)
    ) {
        errors.push(
            `${commandPath}.command ID must encode its canonical raw client slot`
        );
    }
    else if (rawCommandPrefix === undefined) {
        rawCommandPrefix = identity.prefix;
    }
    else if (identity.prefix !== rawCommandPrefix) {
        errors.push(
            `${commandPath}.command ID must share the sample command prefix`
        );
    }
    if (!MUTATION_MIX.includes(command.kind)) {
        errors.push(`${commandPath}.kind is not in the mutation contract`);
    }
    if (!['accepted', 'exhausted'].includes(command.status)) {
        errors.push(`${commandPath}.status must be accepted or exhausted`);
    }
    if (!isNonNegativeNumber(command.latencyMs)) {
        errors.push(`${commandPath}.latencyMs must be non-negative`);
    }
    if (sample.latencySamplesMs?.[index] !== command.latencyMs) {
        errors.push(
            `${path}.latencySamplesMs must exactly preserve raw command latency order`
        );
    }
    if (command.stackIndex !== 0 && command.stackIndex !== 1) {
        errors.push(`${commandPath}.stackIndex must be 0 or 1`);
    }
    return rawCommandPrefix;
}

function validateSampleOutcomeMetrics({ sample, attempts, path, errors }) {
    for (
        const metric of ['attempts', 'conflicted', 'transientRetries', 'exhausted']
    ) {
        compareNumber({
            actual: sample.outcomes?.[metric],
            expected: attempts[metric],
            path: `${path}.outcomes.${metric}`,
            errors: errors,
            source: 'attempt observations'
        });
    }
    compareNumber({
        actual: sample.outcomes?.attemptsPerAcceptedMutation,
        expected: attempts.accepted === 0
            ? 0
            : attempts.attempts / attempts.accepted,
        path: `${path}.outcomes.attemptsPerAcceptedMutation`,
        errors: errors,
        source: 'attempt observations'
    });
    compareNumber({
        actual: sample.outcomes?.accepted,
        expected: attempts.accepted,
        path: `${path}.outcomes.accepted`,
        errors: errors,
        source: 'raw commands'
    });
}

function validateSampleDurableMetrics(
    { sample, attempts, durable, path, errors }
) {
    compareNumber({
        actual: sample.correctness?.acceptedCommandCount,
        expected: attempts.accepted,
        path: `${path}.correctness.acceptedCommandCount`,
        errors: errors,
        source: 'raw commands'
    });
    for (
        const [metric, source] of [
            ['receiptCount', 'durable records'],
            ['effectfulCommandCount', 'mutation contract'],
            ['requiredOutboxIntentCount', 'mutation contract'],
            ['outboxIntentCount', 'durable records']
        ]
    ) {
        compareNumber({
            actual: sample.correctness?.[metric],
            expected: durable[metric],
            path: `${path}.correctness.${metric}`,
            errors: errors,
            source: source
        });
    }
}

function validateSampleLatency({ sample, attempts, path, errors }) {
    const latency = percentileSummary(
        sample.commands.map((command) => command.latencyMs)
    );
    for (const metric of ['p50', 'p95', 'p99']) {
        compareNumber({
            actual: sample.latencyMs?.[metric],
            expected: latency[metric],
            path: `${path}.latencyMs.${metric}`,
            errors: errors,
            source: 'raw samples'
        });
    }
    compareNumber({
        actual: sample.throughputPerSecond,
        expected: attempts.accepted / (sample.durationMs / 1_000),
        path: `${path}.throughputPerSecond`,
        errors: errors,
        source: 'raw commands'
    });
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

function validateMetrics(metrics, path, errors) {
    if (!isObject(metrics)) {
        errors.push(`${path} must be an object`);
        return;
    }
    requireMetric({
        container: metrics,
        metric: 'throughputPerSecond',
        path: path,
        errors: errors
    });
    for (const { container, metrics: fields } of METRIC_GROUPS) {
        for (const metric of fields) {
            requireMetric({ container: metrics[container], metric, path: `${path}.${container}`, errors });
        }
    }
    validateDbwFindings(
        metrics.correctness?.dbwFindings,
        `${path}.correctness`,
        errors
    );
}

function validateDbwFindings(findings, path, errors) {
    if (!isDenseArray(findings)) {
        errors.push(`${path}.dbwFindings must be a dense array`);
        return;
    }
    for (const [index, finding] of findings.entries()) {
        if (!isValidDbwFinding(finding)) {
            errors.push(
                `${path}.dbwFindings[${index}] must be a governed DBW-... finding ID`
            );
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
            ['accepted', 'conflicted', 'transient-retry', 'exhausted'].includes(
                observation.outcome
            ) &&
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
        exhausted: sample.commands.filter((command) => command.status === 'exhausted')
            .length
    }));
    const attempts = sum(attemptMetrics.map((entry) => entry.attempts));
    return {
        latencyMs: percentileSummary(latencySamples),
        throughputPerSecond: accepted / (durationMs / 1_000),
        outcomes: {
            accepted,
            conflicted: sum(attemptMetrics.map((entry) => entry.conflicted)),
            transientRetries: sum(
                attemptMetrics.map((entry) => entry.transientRetries)
            ),
            exhausted: sum(attemptMetrics.map((entry) => entry.exhausted)),
            attempts,
            attemptsPerAcceptedMutation: attempts / accepted
        },
        sql: medianObject(samples.map((sample) => sample.sql)),
        postgres: medianObject(samples.map((sample) => sample.postgres)),
        timingsMs: medianObject(samples.map((sample) => sample.timingsMs)),
        correctness: deriveWorkloadCorrectness(samples, accepted)
    };
}

function deriveWorkloadCorrectness(samples, accepted) {
    return {
        acceptedCommandCount: accepted,
        receiptCount: sum(
            samples.map((sample) => sample.durableEvidence.receipts.length)
        ),
        effectfulCommandCount: sum(
            samples.map((sample) =>
                sample.commands.filter((command) =>
                    command.status === 'accepted' &&
                    PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].length > 0
                ).length
            )
        ),
        requiredOutboxIntentCount: sum(
            samples.map((sample) =>
                requiredStateWriteOutboxCount(
                    sample.commands,
                    sample.durableEvidence.receipts
                )
            )
        ),
        outboxIntentCount: sum(
            samples.map((sample) => sample.durableEvidence.resourceOutbox.length)
        ),
        atomicCompletionFailures: sum(
            samples.map((sample) => sample.durableEvidence.atomicCompletionFailures ?? 0)
        ),
        dbwFindings: [...new Set(samples.flatMap((sample) => sample.correctness.dbwFindings))]
    };
}

/**
 * @typedef {{ summary: unknown, derived: ReturnType<typeof deriveWorkloadSummary>, path: string, errors: string[] }} ValidateDerivedSummaryInput
 * @param {ValidateDerivedSummaryInput} input
 */
function validateDerivedSummary({ summary, derived, path, errors }) {
    validateMetrics(summary, path, errors);
    for (const { container, metrics, source } of METRIC_GROUPS) {
        for (const metric of metrics) {
            compareNumber({
                actual: summary?.[container]?.[metric],
                expected: derived[container][metric],
                path: `${path}.${container}.${metric}`,
                errors: errors,
                source: source
            });
        }
    }
    compareNumber({
        actual: summary?.throughputPerSecond,
        expected: derived.throughputPerSecond,
        path: `${path}.throughputPerSecond`,
        errors: errors,
        source: 'raw samples'
    });
    if (Object.hasOwn(derived.correctness, 'atomicCompletionFailures')) {
        compareNumber({
            actual: summary?.correctness?.atomicCompletionFailures,
            expected: derived.correctness.atomicCompletionFailures,
            path: `${path}.correctness.atomicCompletionFailures`,
            errors: errors,
            source: 'raw durable samples'
        });
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
        failures.push(
            `atomic completion failures (${correctness.atomicCompletionFailures}) != 0`
        );
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
        Object.keys(values[0]).map((
            key
        ) => [key, median(values.map((value) => value[key]))])
    );
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

/**
 * @typedef {{ errors: string[], label: string, baseline: number, candidate: number, ratio: number }} CompareMaximumRegressionInput
 * @param {CompareMaximumRegressionInput} input
 */
function compareMaximumRegression(
    { errors, label, baseline, candidate, ratio }
) {
    if (candidate > baseline * (1 + ratio)) {
        errors.push(
            `${label} regressed by more than ${ratio * 100}%: baseline=${baseline}, candidate=${candidate}`
        );
    }
}

/**
 * @typedef {{ errors: string[], label: string, baseline: number, candidate: number, ratio: number }} CompareMinimumThroughputInput
 * @param {CompareMinimumThroughputInput} input
 */
function compareMinimumThroughput(
    { errors, label, baseline, candidate, ratio }
) {
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

function sum(values) {
    return values.reduce((total, value) => total + value, 0);
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

async function main() {
    const [baselinePath, candidatePath] = process.argv.slice(2);
    if (!baselinePath || !candidatePath) {
        throw new Error(
            'Usage: compare-api-v1-state-write-results.mjs <baseline> <candidate>'
        );
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

if (
    process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
) {
    await main();
}
