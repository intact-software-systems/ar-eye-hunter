#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
    compareStateWriteArtifacts,
    isSubstantiveRegressionReason,
    toStateWriteResourceRegressionMessage
} from './compare-api-v1-state-write-results.mjs';
import { ORDER_BALANCED_STATE_WRITE_PROTOCOL } from './pool-api-v1-state-write-results.mjs';

export const GROUP_STATE_SERVER_STRUCTURE_EQUIVALENCE_RATIO = 0.015;

const RESOURCE_METRICS = [
    { owner: 'sql', metric: 'statements' },
    { owner: 'sql', metric: 'rowsRead' },
    { owner: 'sql', metric: 'serializedResultBytes' },
    { owner: 'postgres', metric: 'transactionDurationMs' }
];
const WORKLOAD_NAMES = ['uncontended', 'shared', 'hot'];

export function compareGroupStateServerStructurePerformance(baseline, candidate) {
    const globalErrors = compareStateWriteArtifacts(baseline, candidate);
    try {
        return applyGroupStateServerStructurePerformancePolicy({
            baseline,
            candidate,
            globalErrors
        });
    }
    catch (error) {
        return [
            ...globalErrors,
            `child performance policy could not be evaluated: ${errorMessage(error)}`
        ];
    }
}

export function applyGroupStateServerStructurePerformancePolicy(input) {
    const { baseline, candidate, globalErrors } = input;
    if (!Array.isArray(globalErrors) || globalErrors.some((error) => typeof error !== 'string')) {
        return ['child performance policy requires the exact global comparator findings'];
    }
    const poolingErrors = validatePooledArtifacts(baseline, candidate);
    if (poolingErrors.length > 0) {
        return [...globalErrors, ...poolingErrors];
    }
    const baselineByName = toWorkloadMap(baseline);
    const candidateByName = toWorkloadMap(candidate);
    const permittedGlobalErrors = new Set();
    const childErrors = [];

    applyThroughputPolicy({
        baselineByName,
        candidateByName,
        permittedGlobalErrors,
        childErrors
    });
    applyResourcePolicy({
        baseline,
        candidate,
        baselineByName,
        candidateByName,
        permittedGlobalErrors,
        childErrors
    });

    return [...globalErrors.filter((error) => !permittedGlobalErrors.has(error)), ...childErrors];
}

function applyThroughputPolicy(input) {
    const sharedBaseline = getThroughput(input.baselineByName, 'shared');
    const sharedCandidate = getThroughput(input.candidateByName, 'shared');
    if (sharedCandidate < sharedBaseline * (1 - GROUP_STATE_SERVER_STRUCTURE_EQUIVALENCE_RATIO)) {
        input.childErrors.push(
            toStructureThroughputBandError('shared', sharedBaseline, sharedCandidate)
        );
    }

    const hotBaseline = getThroughput(input.baselineByName, 'hot');
    const hotCandidate = getThroughput(input.candidateByName, 'hot');
    if (hotCandidate < hotBaseline * 0.9) {
        input.childErrors.push(toStructureThroughputBandError('hot', hotBaseline, hotCandidate));
    }
    else {
        // Must equal the global comparator's compareMinimumThroughput message exactly.
        input.permittedGlobalErrors.add(
            `hot throughput regressed by more than 5%: ` +
                `baseline=${hotBaseline}, candidate=${hotCandidate}`
        );
    }
}

function applyResourcePolicy(input) {
    for (const workloadName of WORKLOAD_NAMES) {
        const baselineWorkload = input.baselineByName.get(workloadName);
        const candidateWorkload = input.candidateByName.get(workloadName);
        for (const descriptor of RESOURCE_METRICS) {
            applyResourceMetricPolicy({
                ...input,
                workloadName,
                descriptor,
                baselineWorkload,
                candidateWorkload
            });
        }
    }
}

function applyResourceMetricPolicy(input) {
    const baselineValue = getResourceValue(input.baselineWorkload, input.descriptor);
    const candidateValue = getResourceValue(input.candidateWorkload, input.descriptor);
    if (candidateValue <= baselineValue) {
        return;
    }
    const globalError = toResourceRegressionError({
        workloadName: input.workloadName,
        descriptor: input.descriptor,
        baselineValue,
        candidateValue
    });
    if (baselineValue === 0) {
        input.childErrors.push(
            `${input.workloadName} ${metricName(input.descriptor)} has a zero baseline and ` +
                `nonzero candidate=${candidateValue}`
        );
        return;
    }
    if (candidateValue <= baselineValue * (1 + GROUP_STATE_SERVER_STRUCTURE_EQUIVALENCE_RATIO)) {
        input.permittedGlobalErrors.add(globalError);
        return;
    }
    if (!hasMeasuredConflictDepthEvidence(input)) {
        input.childErrors.push(
            `${input.workloadName} ${metricName(input.descriptor)} exceeds the 1.5% band without ` +
                'measured conflict-depth evidence'
        );
    }
}

function hasMeasuredConflictDepthEvidence(input) {
    if (!hasRegressionReason(input.candidate, input.workloadName, metricName(input.descriptor))) {
        return false;
    }
    const baselineDepth = conflictDepth(input.baselineWorkload);
    const candidateDepth = conflictDepth(input.candidateWorkload);
    if (
        candidateDepth.medianConflicts <= baselineDepth.medianConflicts ||
        candidateDepth.medianAttempts <= baselineDepth.medianAttempts ||
        candidateDepth.totalConflicts <= baselineDepth.totalConflicts ||
        candidateDepth.totalAttempts <= baselineDepth.totalAttempts ||
        baselineDepth.totalAttempts === 0
    ) {
        return false;
    }
    return pooledResourceCostIsNoWorse({
        baselineWorkload: input.baselineWorkload,
        candidateWorkload: input.candidateWorkload,
        descriptor: input.descriptor,
        baselineAttempts: baselineDepth.totalAttempts,
        candidateAttempts: candidateDepth.totalAttempts
    });
}

function hasRegressionReason(candidate, workload, metric) {
    return candidate.regressionReasons.some(
        (entry) =>
            entry?.workload === workload &&
            entry.metric === metric &&
            isSubstantiveRegressionReason(entry.reason)
    );
}

function conflictDepth(workload) {
    const attempts = workload.samples.map((sample) => getOutcome(sample, 'attempts'));
    const conflicts = workload.samples.map((sample) => getOutcome(sample, 'conflicted'));
    return {
        medianAttempts: median(attempts),
        medianConflicts: median(conflicts),
        totalConflicts: sum(conflicts),
        totalAttempts: sum(attempts)
    };
}

function pooledResourceCostIsNoWorse(input) {
    const baselineMean = pooledResourceMean(input.baselineWorkload, input.descriptor);
    const candidateMean = pooledResourceMean(input.candidateWorkload, input.descriptor);
    if (baselineMean === 0) {
        return candidateMean === 0;
    }
    return candidateMean / baselineMean <= input.candidateAttempts / input.baselineAttempts;
}

function pooledResourceMean(workload, descriptor) {
    return mean(
        workload.samples.map((sample) => toNonNegativeNumber(sample[descriptor.owner]?.[descriptor.metric]))
    );
}

function getOutcome(sample, metric) {
    const value = toNonNegativeNumber(sample.outcomes?.[metric]);
    if (!Number.isSafeInteger(value)) {
        throw new TypeError('performance outcome must be a non-negative safe integer');
    }
    return value;
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function mean(values) {
    return values.reduce((average, value, index) => average + (value - average) / (index + 1), 0);
}

function sum(values) {
    const total = values.reduce((result, value) => result + value, 0);
    if (!Number.isSafeInteger(total)) {
        throw new TypeError('performance outcome total must be a non-negative safe integer');
    }
    return total;
}

function validatePooledArtifacts(baseline, candidate) {
    const errors = [
        ...validatePooledArtifact(baseline, 'approved-base'),
        ...validatePooledArtifact(candidate, 'candidate')
    ];
    if (baseline?.aggregation?.environmentSha256 !== candidate?.aggregation?.environmentSha256) {
        errors.push('pooled A-B-B-A environment hashes must match');
    }
    const sourceHashes = [
        ...(baseline?.aggregation?.sourceArtifactSha256 ?? []),
        ...(candidate?.aggregation?.sourceArtifactSha256 ?? [])
    ];
    if (sourceHashes.length !== 4 || new Set(sourceHashes).size !== 4) {
        errors.push('pooled A-B-B-A source artifact hashes must be four unique values');
    }
    return errors;
}

function validatePooledArtifact(artifact, expectedRole) {
    const errors = [];
    const aggregation = artifact?.aggregation;
    const aggregationKeys = aggregation && typeof aggregation === 'object' ? Object.keys(aggregation).sort() : [];
    if (
        JSON.stringify(aggregationKeys) !==
            JSON.stringify(['environmentSha256', 'protocol', 'role', 'sourceArtifactSha256']) ||
        aggregation?.protocol !== ORDER_BALANCED_STATE_WRITE_PROTOCOL ||
        aggregation?.role !== expectedRole ||
        !isSha256(aggregation?.environmentSha256) ||
        !Array.isArray(aggregation?.sourceArtifactSha256) ||
        aggregation.sourceArtifactSha256.length !== 2 ||
        aggregation.sourceArtifactSha256.some((hash) => !isSha256(hash))
    ) {
        errors.push(`${expectedRole} must use the exact pooled A-B-B-A metadata`);
    }
    if (artifact?.measurement?.measuredRuns !== 18) {
        errors.push(`${expectedRole} pooled A-B-B-A measurement must contain 18 runs`);
    }
    if (
        !Array.isArray(artifact?.workloads) ||
        artifact.workloads.some(
            (workload) => workload?.measuredRuns !== 18 || workload?.samples?.length !== 18
        )
    ) {
        errors.push(`${expectedRole} pooled A-B-B-A workloads must each contain 18 samples`);
    }
    return errors;
}

export function validateGroupStateServerStructureEvidence(evidence) {
    if (!isSha256(evidence?.expectedManifestSha256)) {
        return ['expected governed manifest hash must be a lowercase SHA-256'];
    }
    const errors = [];
    if (sha256(evidence.manifestText) !== evidence.expectedManifestSha256) {
        errors.push('governed manifest hash does not match the expected SHA-256');
    }
    let manifest;
    try {
        manifest = JSON.parse(evidence.manifestText);
    }
    catch (error) {
        return [...errors, `governed manifest is not valid JSON: ${errorMessage(error)}`];
    }
    if (manifest?.schemaVersion !== ORDER_BALANCED_STATE_WRITE_PROTOCOL) {
        errors.push('governed manifest does not use the pooled A-B-B-A protocol');
    }
    if (sha256(evidence.baselineText) !== manifest?.outputs?.approvedBase?.sha256) {
        errors.push('approved-base output hash does not match the governed manifest');
    }
    if (sha256(evidence.candidateText) !== manifest?.outputs?.candidate?.sha256) {
        errors.push('candidate output hash does not match the governed manifest');
    }
    return errors;
}

function toWorkloadMap(artifact) {
    if (!artifact || !Array.isArray(artifact.workloads)) {
        throw new TypeError('artifact workloads are unavailable');
    }
    const workloads = new Map(artifact.workloads.map((workload) => [workload.name, workload]));
    if (WORKLOAD_NAMES.some((name) => !workloads.has(name))) {
        throw new TypeError('artifact workloads are incomplete');
    }
    return workloads;
}

function getThroughput(workloads, workloadName) {
    return toNonNegativeNumber(workloads.get(workloadName).summary.throughputPerSecond);
}

function getResourceValue(workload, descriptor) {
    return toNonNegativeNumber(workload.summary[descriptor.owner][descriptor.metric]);
}

function toNonNegativeNumber(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError('performance metric must be a non-negative finite number');
    }
    return value;
}

const STRUCTURE_THROUGHPUT_BANDS = { shared: '1.5%', hot: '10%' };

function toStructureThroughputBandError(workloadName, baseline, candidate) {
    return (
        `${workloadName} throughput fell below the ${STRUCTURE_THROUGHPUT_BANDS[workloadName]} ` +
        `structure-equivalence band: baseline=${baseline}, candidate=${candidate}`
    );
}

function toResourceRegressionError(input) {
    return toStateWriteResourceRegressionMessage({
        workload: input.workloadName,
        metric: metricName(input.descriptor),
        baselineMedian: input.baselineValue,
        candidateMedian: input.candidateValue
    });
}

function metricName(descriptor) {
    return `${descriptor.owner}.${descriptor.metric}`;
}

async function main() {
    const [baselinePath, candidatePath, manifestPath, expectedManifestSha256] = process.argv.slice(2);
    if (!baselinePath || !candidatePath || !manifestPath || !expectedManifestSha256) {
        throw new Error(
            'Usage: compare-group-state-server-structure-performance.mjs ' +
                '<baseline> <candidate> <manifest> <expected-manifest-sha256>'
        );
    }
    const [baselineText, candidateText, manifestText] = await Promise.all([
        readFile(baselinePath, 'utf8'),
        readFile(candidatePath, 'utf8'),
        readFile(manifestPath, 'utf8')
    ]);
    const evidenceErrors = validateGroupStateServerStructureEvidence({
        baselineText,
        candidateText,
        manifestText,
        expectedManifestSha256
    });
    if (evidenceErrors.length > 0) {
        console.error(evidenceErrors.map((error) => `- ${error}`).join('\n'));
        process.exitCode = 1;
        return;
    }
    const baseline = JSON.parse(baselineText);
    const candidate = JSON.parse(candidateText);
    const errors = compareGroupStateServerStructurePerformance(baseline, candidate);
    if (errors.length > 0) {
        console.error(errors.map((error) => `- ${error}`).join('\n'));
        process.exitCode = 1;
        return;
    }
    console.log('Group-state server structure performance is equivalent within 1.5%.');
}

function isSha256(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
