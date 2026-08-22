#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CRDT_APPEND_HISTORY_SAMPLE_COUNT = 20;
const CRDT_APPEND_HISTORY_RECIPE = 'packages/shared-test/black-box-runner/tests/api-v1/api-v1-crdt-append-history.json';

export const CRDT_APPEND_HISTORY_CASES = Object.freeze([
    Object.freeze({
        name: 'small',
        artifactName: 'api-v1-crdt-append-history-small',
        seedHistorySize: 10,
        finalHistorySize: 30
    }),
    Object.freeze({
        name: 'medium',
        artifactName: 'api-v1-crdt-append-history-medium',
        seedHistorySize: 100,
        finalHistorySize: 120
    }),
    Object.freeze({
        name: 'large',
        artifactName: 'api-v1-crdt-append-history-large',
        seedHistorySize: 480,
        finalHistorySize: 500
    })
]);

export function analyzeCrdtAppendHistoryReport(report, testCase) {
    const issues = [];
    if (!isObject(report)) {
        return invalidAnalysis(testCase, ['report must be an object']);
    }
    if (!isObject(testCase) || typeof testCase.name !== 'string') {
        return invalidAnalysis({ name: 'unknown' }, ['test case must be a named object']);
    }
    if (!isObject(report.summary) || report.summary.failure !== 0) {
        issues.push('report summary must record zero failures');
    }
    if (!isDenseArray(report.resultsList)) {
        return invalidAnalysis(testCase, [...issues, 'resultsList must be a dense array']);
    }

    const newAppend = analyzeMeasurementFamily({
        results: report.resultsList,
        sendPrefix: 'measureNewAppend',
        replyPrefix: 'observeNewAppendReply',
        label: 'new append',
        issues
    });
    const duplicateReplay = analyzeMeasurementFamily({
        results: report.resultsList,
        sendPrefix: 'measureDuplicateReplay',
        replyPrefix: 'observeDuplicateReplayReply',
        label: 'duplicate replay',
        issues
    });

    return {
        caseName: testCase.name,
        seedHistorySize: testCase.seedHistorySize,
        finalHistorySize: testCase.finalHistorySize,
        issues,
        newAppend,
        duplicateReplay
    };
}

export function validateCrdtAppendHistoryArtifactCase(expandedRecipe, testCase) {
    if (!isObject(testCase) || typeof testCase.name !== 'string') {
        return ['test case must be a named object'];
    }
    if (
        !isObject(expandedRecipe) ||
        expandedRecipe.sourceConfig !== CRDT_APPEND_HISTORY_RECIPE ||
        !isObject(expandedRecipe.recipe) ||
        !isObject(expandedRecipe.recipe.variables)
    ) {
        return ['expanded recipe must identify the CRDT append-history recipe and variables'];
    }
    const variables = expandedRecipe.recipe.variables;
    const expectations = [
        ['historySize', testCase.seedHistorySize],
        ['expectedFinalHistorySize', testCase.finalHistorySize],
        ['finalPreviousSequence', testCase.finalHistorySize - 1]
    ];
    return expectations.flatMap(([name, expected]) =>
        variables[name] === String(expected) ? [] : [`expanded recipe ${name} must equal ${expected}`]
    );
}

export async function compareCrdtAppendHistoryArtifactRoots(baselineRoot, candidateRoot) {
    const comparisons = [];
    const issues = [];
    for (const testCase of CRDT_APPEND_HISTORY_CASES) {
        const [baselineArtifact, candidateArtifact] = await Promise.all([
            readArtifact(baselineRoot, testCase.artifactName),
            readArtifact(candidateRoot, testCase.artifactName)
        ]);
        const baseline = analyzeCrdtAppendHistoryReport(baselineArtifact.report, testCase);
        const candidate = analyzeCrdtAppendHistoryReport(candidateArtifact.report, testCase);
        issues.push(
            ...validateCrdtAppendHistoryArtifactCase(baselineArtifact.expandedRecipe, testCase).map(
                (issue) => `baseline ${testCase.name}: ${issue}`
            ),
            ...validateCrdtAppendHistoryArtifactCase(candidateArtifact.expandedRecipe, testCase).map(
                (issue) => `candidate ${testCase.name}: ${issue}`
            ),
            ...baseline.issues.map((issue) => `baseline ${testCase.name}: ${issue}`),
            ...candidate.issues.map((issue) => `candidate ${testCase.name}: ${issue}`)
        );
        comparisons.push({
            caseName: testCase.name,
            seedHistorySize: testCase.seedHistorySize,
            finalHistorySize: testCase.finalHistorySize,
            newAppend: compareMeasurementSummaries(baseline.newAppend, candidate.newAppend),
            duplicateReplay: compareMeasurementSummaries(
                baseline.duplicateReplay,
                candidate.duplicateReplay
            )
        });
    }
    return {
        schemaVersion: 'rallar.crdt-append-history-comparison.v1',
        baselineRoot,
        candidateRoot,
        issues,
        comparisons
    };
}

function analyzeMeasurementFamily(input) {
    const samples = [];
    const expectedNames = new Set();
    for (let iteration = 1; iteration <= CRDT_APPEND_HISTORY_SAMPLE_COUNT; iteration += 1) {
        const sendName = `${input.sendPrefix}${iteration}`;
        const replyName = `${input.replyPrefix}${iteration}`;
        expectedNames.add(sendName);
        expectedNames.add(replyName);
        const sends = input.results.filter((result) => result?.name === sendName);
        const replies = input.results.filter((result) => result?.name === replyName);
        if (sends.length !== 1 || replies.length !== 1) {
            input.issues.push(
                `${input.label} iteration ${iteration} must have exactly one send and one reply`
            );
            continue;
        }
        const [send] = sends;
        const [reply] = replies;
        if (send.status !== 'SUCCESS' || reply.status !== 'SUCCESS') {
            input.issues.push(`${input.label} iteration ${iteration} must succeed`);
            continue;
        }
        if (!hasValidTiming(send) || !hasValidTiming(reply)) {
            input.issues.push(`${input.label} iteration ${iteration} timing is malformed`);
            continue;
        }
        const durationMs = reply.endedAtEpochMs - send.startedAtEpochMs;
        if (
            durationMs < 0 ||
            send.endedAtEpochMs > reply.startedAtEpochMs ||
            reply.startedAtEpochMs > reply.endedAtEpochMs
        ) {
            input.issues.push(`${input.label} iteration ${iteration} timing is non-monotonic`);
            continue;
        }
        samples.push(durationMs);
    }

    const unexpectedNames = input.results
        .map((result) => result?.name)
        .filter(
            (name) =>
                typeof name === 'string' &&
                (name.startsWith(input.sendPrefix) || name.startsWith(input.replyPrefix)) &&
                !expectedNames.has(name)
        );
    if (unexpectedNames.length > 0) {
        input.issues.push(`${input.label} contains unexpected measurement names`);
    }

    if (samples.length !== CRDT_APPEND_HISTORY_SAMPLE_COUNT) {
        input.issues.push(
            `${input.label} must contain ${CRDT_APPEND_HISTORY_SAMPLE_COUNT} valid paired samples`
        );
    }
    return summarize(samples);
}

function compareMeasurementSummaries(baseline, candidate) {
    return {
        baseline,
        candidate,
        candidateToBaselineP50Ratio: ratio(candidate.p50Ms, baseline.p50Ms),
        candidateToBaselineP95Ratio: ratio(candidate.p95Ms, baseline.p95Ms)
    };
}

function summarize(samples) {
    const sorted = [...samples].sort((left, right) => left - right);
    return {
        count: sorted.length,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        minMs: sorted.at(0) ?? null,
        maxMs: sorted.at(-1) ?? null
    };
}

function percentile(sorted, percentileValue) {
    if (sorted.length === 0) {
        return null;
    }
    return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)];
}

function ratio(candidate, baseline) {
    return typeof candidate === 'number' && typeof baseline === 'number' && baseline > 0
        ? candidate / baseline
        : null;
}

function hasValidTiming(result) {
    return (
        Number.isFinite(result.startedAtEpochMs) &&
        Number.isFinite(result.endedAtEpochMs) &&
        Number.isFinite(result.durationMs) &&
        result.startedAtEpochMs <= result.endedAtEpochMs &&
        result.durationMs === result.endedAtEpochMs - result.startedAtEpochMs
    );
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDenseArray(value) {
    return Array.isArray(value) && Object.keys(value).length === value.length;
}

function invalidAnalysis(testCase, issues) {
    return {
        caseName: testCase.name,
        seedHistorySize: testCase.seedHistorySize,
        finalHistorySize: testCase.finalHistorySize,
        issues,
        newAppend: summarize([]),
        duplicateReplay: summarize([])
    };
}

async function readArtifact(root, artifactName) {
    const artifactRoot = path.join(root, artifactName);
    const [report, expandedRecipe] = await Promise.all([
        readJson(path.join(artifactRoot, 'report.json')),
        readJson(path.join(artifactRoot, 'expanded-recipe.json'))
    ]);
    return { report, expandedRecipe };
}

async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

async function runCli() {
    const [baselineRoot, candidateRoot] = process.argv.slice(2);
    if (!baselineRoot || !candidateRoot) {
        console.error(
            'Usage: compare-api-v1-crdt-append-history-results.mjs <baseline-root> <candidate-root>'
        );
        process.exitCode = 2;
        return;
    }
    try {
        const comparison = await compareCrdtAppendHistoryArtifactRoots(baselineRoot, candidateRoot);
        console.log(JSON.stringify(comparison, null, 2));
        if (comparison.issues.length > 0) {
            process.exitCode = 1;
        }
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await runCli();
}
