#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
    PRODUCTION_STATE_WRITE_MUTATION_CONTRACT,
    validateStateWriteArtifact
} from './compare-api-v1-state-write-results.mjs';
import { validateStateWritePoolingSource } from './validate-state-write-pooling-source.mjs';

export const ORDER_BALANCED_STATE_WRITE_PROTOCOL = 'rallar.api-v1.state-write.order-balanced-abba.v1';
const LEGACY_SOURCE_POSITIONS = [
    { key: 'approvedBaseFirst', position: 1, role: 'approved-base' },
    { key: 'candidateFirst', position: 2, role: 'candidate' },
    { key: 'candidateSecond', position: 3, role: 'candidate' },
    { key: 'approvedBaseSecond', position: 4, role: 'approved-base' }
];

export function poolApiV1StateWriteResults(input) {
    return poolStateWriteResults(input, LEGACY_SOURCE_POSITIONS, 'A-B-B-A');
}

export function poolApiV1StateWriteResultsForPositions(input, sourcePositions) {
    const positions = validateSourcePositions(sourcePositions);
    return poolStateWriteResults(input, positions, 'explicit position');
}

function poolStateWriteResults(input, sourcePositions, orderLabel) {
    validateExpectedCommits(input);
    const sources = readAndValidateSources(input.sources, sourcePositions);
    validateSourceSet(sources, input, orderLabel);
    const environmentSha256 = sources[0].environmentSha256;
    const approvedBaseSources = sources.filter((source) => source.role === 'approved-base');
    const candidateSources = sources.filter((source) => source.role === 'candidate');
    const approvedBase = poolRoleArtifacts({
        sources: approvedBaseSources,
        expectedCommit: input.expectedApprovedBaseCommit,
        role: 'approved-base',
        environmentSha256
    });
    const candidate = poolRoleArtifacts({
        sources: candidateSources,
        expectedCommit: input.expectedCandidateCommit,
        role: 'candidate',
        environmentSha256
    });
    return {
        approvedBase,
        candidate,
        manifest: createManifest(input, sources, environmentSha256)
    };
}

function validateSourcePositions(value) {
    if (
        !Array.isArray(value) ||
        value.length !== 4 ||
        ![0, 1, 2, 3].every((index) => Object.hasOwn(value, index))
    ) {
        throw new TypeError('source positions must be a dense four-entry array');
    }
    const positions = value.map((descriptor, index) => {
        if (
            !isObject(descriptor) ||
            canonicalJson(Object.keys(descriptor).toSorted()) !== '["key","position","role"]'
        ) {
            throw new TypeError(
                `source position ${index + 1} fields must be exactly key, position, role`
            );
        }
        if (typeof descriptor.key !== 'string' || descriptor.key.length === 0) {
            throw new TypeError(`source position ${index + 1} key must be non-empty`);
        }
        if (descriptor.position !== index + 1) {
            throw new TypeError('source positions must be 1, 2, 3, 4 in order');
        }
        if (descriptor.role !== 'approved-base' && descriptor.role !== 'candidate') {
            throw new TypeError(`source position ${index + 1} role is unsupported`);
        }
        return descriptor;
    });
    if (new Set(positions.map(({ key }) => key)).size !== 4) {
        throw new TypeError('source position keys must be unique');
    }
    if (positions.filter(({ role }) => role === 'approved-base').length !== 2) {
        throw new TypeError('source roles must contain two approved-base and two candidate positions');
    }
    return positions;
}
function validateExpectedCommits(input) {
    if (!isObject(input)) {
        throw new TypeError('pooling input must be an object');
    }
    for (
        const [name, value] of [
            ['approved-base', input.expectedApprovedBaseCommit],
            ['candidate', input.expectedCandidateCommit]
        ]
    ) {
        if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
            throw new TypeError(`expected ${name} commit must be a full lowercase Git SHA`);
        }
    }
    if (input.expectedApprovedBaseCommit === input.expectedCandidateCommit) {
        throw new TypeError('approved-base and candidate commits must differ');
    }
}
function readAndValidateSources(sourceInput, sourcePositions) {
    if (!isObject(sourceInput)) {
        throw new TypeError('pooling sources must be an object');
    }
    return sourcePositions.map((descriptor) => {
        const source = sourceInput[descriptor.key];
        if (
            !isObject(source) ||
            typeof source.artifactText !== 'string' ||
            typeof source.environmentText !== 'string' ||
            source.environmentText.length === 0 ||
            typeof source.sourceName !== 'string' ||
            source.sourceName.length === 0
        ) {
            throw new TypeError(`position ${descriptor.position} source is incomplete`);
        }
        const artifact = parseArtifact(source.artifactText, descriptor.position);
        validateStateWritePoolingSource({
            artifact,
            environmentText: source.environmentText,
            position: descriptor.position
        });
        return {
            ...descriptor,
            artifact,
            artifactSha256: sha256(source.artifactText),
            environmentSha256: sha256(source.environmentText),
            environmentText: source.environmentText,
            sourceName: source.sourceName
        };
    });
}
function parseArtifact(artifactText, position) {
    try {
        return JSON.parse(artifactText);
    }
    catch (error) {
        throw new TypeError(`position ${position} artifact is not valid JSON: ${errorMessage(error)}`);
    }
}
function validateSourceSet(sources, input, orderLabel) {
    validateUniqueHashes(sources);
    validateEnvironments(sources);
    validateGeneratedOrder(sources, orderLabel);
    validateCommits(sources, input);
    validateCompatibleMetadata(sources);
    validateUniqueRawCommandIds(sources);
}

function validateUniqueHashes(sources) {
    if (new Set(sources.map((source) => source.artifactSha256)).size !== sources.length) {
        throw new TypeError('source artifact hashes must be unique; no measurement may be reused');
    }
}

function validateEnvironments(sources) {
    const expected = sources[0].environmentText;
    if (sources.some((source) => source.environmentText !== expected)) {
        throw new TypeError('normalized environment records must match byte-for-byte');
    }
}

function validateGeneratedOrder(sources, orderLabel) {
    const timestamps = sources.map((source) => Date.parse(source.artifact.generatedAt));
    if (timestamps.some((timestamp, index) => index > 0 && timestamp <= timestamps[index - 1])) {
        throw new TypeError(`artifact generatedAt values must increase in ${orderLabel} order`);
    }
}

function validateCommits(sources, input) {
    for (const source of sources) {
        const expected = source.role === 'approved-base'
            ? input.expectedApprovedBaseCommit
            : input.expectedCandidateCommit;
        if (source.artifact.gitCommit !== expected) {
            throw new TypeError(
                `position ${source.position} ${source.role} commit must equal ${expected}`
            );
        }
    }
}

function validateCompatibleMetadata(sources) {
    const measurement = canonicalJson(sources[0].artifact.measurement);
    if (sources.some((source) => canonicalJson(source.artifact.measurement) !== measurement)) {
        throw new TypeError('all source measurement metadata must match');
    }
    for (const role of ['approved-base', 'candidate']) {
        const roleSources = sources.filter((source) => source.role === role);
        const expected = canonicalJson(toRoleMetadata(roleSources[0].artifact));
        if (roleSources.some((source) => canonicalJson(toRoleMetadata(source.artifact)) !== expected)) {
            throw new TypeError(`${role} artifact metadata must match`);
        }
    }
}

function toRoleMetadata(artifact) {
    return {
        schemaVersion: artifact.schemaVersion,
        backend: artifact.backend,
        regressionReasons: artifact.regressionReasons,
        workloads: artifact.workloads.map((workload) => ({
            name: workload.name,
            scale: workload.scale,
            mutationMix: workload.mutationMix,
            warmupRuns: workload.warmupRuns,
            measuredRuns: workload.measuredRuns
        }))
    };
}

function validateUniqueRawCommandIds(sources) {
    for (const role of ['approved-base', 'candidate']) {
        const roleSources = sources.filter((source) => source.role === role);
        for (const workloadName of ['uncontended', 'shared', 'hot']) {
            const commandIds = roleSources.flatMap((source) => {
                const workload = source.artifact.workloads.find(
                    (candidate) => candidate.name === workloadName
                );
                return workload.samples.flatMap((sample) => sample.commands.map((command) => command.commandId));
            });
            if (new Set(commandIds).size !== commandIds.length) {
                throw new TypeError('raw command IDs must be unique across pooled sources');
            }
        }
    }
}

function poolRoleArtifacts({ sources, expectedCommit, role, environmentSha256 }) {
    const first = sources[0].artifact;
    const second = sources[1].artifact;
    const workloads = first.workloads.map((workload) => {
        const counterpart = second.workloads.find((candidate) => candidate.name === workload.name);
        const samples = [...workload.samples, ...counterpart.samples].map((sample, runIndex) => ({
            ...structuredClone(sample),
            runIndex
        }));
        return {
            ...structuredClone(workload),
            measuredRuns: 18,
            samples,
            summary: summarizeSamples(samples)
        };
    });
    const pooled = {
        ...structuredClone(first),
        gitCommit: expectedCommit,
        generatedAt: second.generatedAt,
        measurement: { ...structuredClone(first.measurement), measuredRuns: 18 },
        workloads,
        aggregation: {
            protocol: ORDER_BALANCED_STATE_WRITE_PROTOCOL,
            role,
            environmentSha256,
            sourceArtifactSha256: sources.map((source) => source.artifactSha256)
        }
    };
    const errors = validateStateWriteArtifact(pooled);
    if (errors.length > 0) {
        throw new TypeError(`${role} pooled artifact validation failed: ${errors.join('; ')}`);
    }
    return pooled;
}

function summarizeSamples(samples) {
    const commands = samples.flatMap((sample) => sample.commands);
    const accepted = commands.filter((command) => command.status === 'accepted').length;
    const attempts = sum(samples.map((sample) => sample.attemptObservations.length));
    return {
        latencyMs: percentileSummary(commands.map((command) => command.latencyMs)),
        throughputPerSecond: accepted / (sum(samples.map((sample) => sample.durationMs)) / 1_000),
        outcomes: {
            accepted,
            conflicted: countAttempts(samples, 'conflicted'),
            transientRetries: countAttempts(samples, 'transient-retry'),
            exhausted: commands.filter((command) => command.status === 'exhausted').length,
            attempts,
            attemptsPerAcceptedMutation: attempts / accepted
        },
        sql: medianObject(samples.map((sample) => sample.sql)),
        postgres: medianObject(samples.map((sample) => sample.postgres)),
        timingsMs: medianObject(samples.map((sample) => sample.timingsMs)),
        correctness: summarizeCorrectness(samples, commands)
    };
}

function summarizeCorrectness(samples, commands) {
    const acceptedCommands = commands.filter((command) => command.status === 'accepted');
    const sumSampleMetric = (name) => sum(samples.map((sample) => sample.correctness[name]));
    return {
        acceptedCommandCount: acceptedCommands.length,
        receiptCount: sum(samples.map((sample) => sample.durableEvidence.receipts.length)),
        effectfulCommandCount: acceptedCommands.filter(
            (command) => PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].length > 0
        ).length,
        requiredOutboxIntentCount: sum(
            acceptedCommands.map(
                (command) => PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].length
            )
        ),
        outboxIntentCount: sum(samples.map((sample) => sample.durableEvidence.resourceOutbox.length)),
        atomicCompletionFailures: sumSampleMetric('atomicCompletionFailures'),
        dbwFindings: [...new Set(samples.flatMap((sample) => sample.correctness.dbwFindings))]
    };
}

function countAttempts(samples, outcome) {
    return sum(
        samples.map(
            (sample) => sample.attemptObservations.filter((attempt) => attempt.outcome === outcome).length
        )
    );
}

function percentileSummary(values) {
    return {
        p50: percentile(values, 0.5),
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

function createManifest(input, sources, environmentSha256) {
    return {
        schemaVersion: ORDER_BALANCED_STATE_WRITE_PROTOCOL,
        expectedApprovedBaseCommit: input.expectedApprovedBaseCommit,
        expectedCandidateCommit: input.expectedCandidateCommit,
        environmentSha256,
        positions: sources.map((source) => ({
            position: source.position,
            role: source.role,
            sourceName: source.sourceName,
            artifactSha256: source.artifactSha256,
            gitCommit: source.artifact.gitCommit,
            generatedAt: source.artifact.generatedAt
        }))
    };
}

function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (isObject(value)) {
        return `{${
            Object.keys(value)
                .sort()
                .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
                .join(',')
        }}`;
    }
    return JSON.stringify(value);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sum = (values) => values.reduce((total, value) => total + value, 0);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorMessage = (error) => (error instanceof Error ? error.message : String(error));
