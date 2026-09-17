import type { DistributedRunEventEvidence } from '../distributed-artifact-analysis/decode-distributed-run-event-evidence.ts';
import type { DistributedRunResultEvidence } from '../distributed-artifact-analysis/decode-distributed-run-result-evidence.ts';
import {
    createStreamSampleGroupHeap,
    getOldestStreamSampleGroup,
    pushStreamSampleGroup,
    removeStaleStreamSampleGroupEntries,
    type StreamSampleGroupHeap
} from './stream-sample-group-heap.ts';
import {
    computeStreamInFlightLimitDropCount,
    toEventStreamTimingSample,
    toResultStreamTimingSamples,
    toStreamEventPriority,
    type StreamTimingSample
} from './to-stream-timing-samples.ts';

export interface StreamTimingSampleSources {
    readonly controlResults: readonly DistributedRunResultEvidence[];
    readonly jsonlResults: readonly DistributedRunResultEvidence[];
    readonly events: readonly DistributedRunEventEvidence[];
}

export interface StreamSampleIndexTelemetry {
    readonly candidateCount: number;
    readonly fingerprintComputationCount: number;
    readonly indexLookupCount: number;
    readonly equivalenceCheckCount: number;
    readonly indexMaintenanceCount: number;
    readonly replacementCount: number;
    readonly groupCount: number;
    readonly outputGroupOrder: readonly StreamSampleGroupOrder[];
}

export interface StreamSampleGroupOrder {
    readonly insertionIndex: number;
    readonly winnerIndex: number;
}

/** The best sample per stream execution in first-seen order, with the work the index did to choose them. */
export interface StreamTimingSampleSelection {
    readonly samples: readonly StreamTimingSample[];
    readonly telemetry: StreamSampleIndexTelemetry;
}

interface StreamTimingSampleCandidate {
    readonly sample: StreamTimingSample;
    readonly sourcePriority: number;
    readonly index: number;
}

interface PreparedStreamTimingSampleCandidate {
    readonly candidate: StreamTimingSampleCandidate;
    readonly baseKey: string;
    readonly fingerprint: string;
}

interface IndexedStreamSampleGroup {
    readonly canonicalKey: string;
    readonly insertionIndex: number;
    version: number;
    prepared: PreparedStreamTimingSampleCandidate;
}

type IndexedStreamSampleGroupHeap = StreamSampleGroupHeap<IndexedStreamSampleGroup>;

interface StreamSampleGroupResolution {
    /** Absent when no oldest candidate group is the same stream execution. */
    readonly group: IndexedStreamSampleGroup | undefined;
    readonly checkedGroupCount: number;
}

interface StreamSampleFingerprintIndexes {
    readonly identityless: IndexedStreamSampleGroupHeap;
    readonly identityBearing: IndexedStreamSampleGroupHeap;
    readonly nestedIdentity: IndexedStreamSampleGroupHeap;
    readonly nonNestedIdentity: IndexedStreamSampleGroupHeap;
    readonly nonNestedIdentityBySource: Map<number, IndexedStreamSampleGroupHeap>;
}

interface StreamSampleBaseBucket {
    readonly identityless: IndexedStreamSampleGroupHeap;
    readonly identities: Map<string, IndexedStreamSampleGroupHeap>;
    readonly fingerprints: Map<string, StreamSampleFingerprintIndexes>;
}

interface StreamSampleIndexWork {
    candidateCount: number;
    fingerprintComputationCount: number;
    indexLookupCount: number;
    equivalenceCheckCount: number;
    indexMaintenanceCount: number;
    replacementCount: number;
}

interface StreamSampleIndex {
    readonly buckets: Map<string, StreamSampleBaseBucket>;
    readonly groups: IndexedStreamSampleGroup[];
    readonly groupsByCanonicalKey: Map<string, IndexedStreamSampleGroup>;
    readonly work: StreamSampleIndexWork;
}

const CONTROL_RESULT_PRIORITY = 40;
const JSONL_RESULT_PRIORITY = 50;

export function computeStreamTimingSamples(sources: StreamTimingSampleSources): StreamTimingSampleSelection {
    const sampleIndex = createStreamSampleIndex();
    const candidates = toStreamTimingSampleCandidates(sources);
    for (const candidate of candidates) {
        upsertBestStreamSample(sampleIndex, candidate);
    }
    const outputGroups = [...sampleIndex.groups]
        .sort((left, right) => left.prepared.candidate.index - right.prepared.candidate.index);
    return {
        samples: outputGroups.map((group) => group.prepared.candidate.sample),
        telemetry: {
            ...sampleIndex.work,
            groupCount: sampleIndex.groups.length,
            outputGroupOrder: outputGroups.map((group) => ({
                insertionIndex: group.insertionIndex,
                winnerIndex: group.prepared.candidate.index
            }))
        }
    };
}

function toStreamTimingSampleCandidates(sources: StreamTimingSampleSources): readonly StreamTimingSampleCandidate[] {
    const prioritized = [
        ...sources.controlResults.flatMap((result) =>
            toResultStreamTimingSamples(result).map((sample) => ({ sample, sourcePriority: CONTROL_RESULT_PRIORITY }))
        ),
        ...sources.jsonlResults.flatMap((result) =>
            toResultStreamTimingSamples(result).map((sample) => ({ sample, sourcePriority: JSONL_RESULT_PRIORITY }))
        ),
        ...sources.events.flatMap((event) => {
            const sample = toEventStreamTimingSample(event);
            return sample === undefined ? [] : [{ sample, sourcePriority: toStreamEventPriority(event) * 10 }];
        })
    ];
    return prioritized.map((candidate, index) => ({ ...candidate, index }));
}

function upsertBestStreamSample(index: StreamSampleIndex, candidate: StreamTimingSampleCandidate): void {
    const prepared = toPreparedStreamSampleCandidate(candidate);
    index.work.candidateCount += 1;
    index.work.fingerprintComputationCount += 1;
    const bucket = index.buckets.get(prepared.baseKey) ?? createStreamSampleBaseBucket();
    index.buckets.set(prepared.baseKey, bucket);
    const candidateHeaps = toCandidateHeaps(bucket, prepared);
    removeStaleCandidateHeapEntries(candidateHeaps, index.work);
    const resolution = resolveEquivalentStreamSampleGroup(candidateHeaps, prepared);
    index.work.equivalenceCheckCount += resolution.checkedGroupCount;
    let currentGroup = resolution.group;
    if (!currentGroup) {
        index.work.indexLookupCount += 1;
        currentGroup = index.groupsByCanonicalKey.get(toStreamSampleKey(prepared));
    }
    if (!currentGroup) {
        insertStreamSampleGroup(index, bucket, prepared);
        return;
    }
    if (computeStreamSampleCandidateOrder(candidate, currentGroup.prepared.candidate) > 0) {
        currentGroup.version += 1;
        currentGroup.prepared = prepared;
        index.work.replacementCount += 1;
        registerStreamSampleGroup(bucket, currentGroup, index.work);
    }
}

function insertStreamSampleGroup(
    index: StreamSampleIndex,
    bucket: StreamSampleBaseBucket,
    prepared: PreparedStreamTimingSampleCandidate
): void {
    const group: IndexedStreamSampleGroup = {
        canonicalKey: toStreamSampleKey(prepared),
        insertionIndex: prepared.candidate.index,
        version: 0,
        prepared
    };
    index.groups.push(group);
    index.groupsByCanonicalKey.set(group.canonicalKey, group);
    registerStreamSampleGroup(bucket, group, index.work);
}

function createStreamSampleIndex(): StreamSampleIndex {
    return {
        buckets: new Map(),
        groups: [],
        groupsByCanonicalKey: new Map(),
        work: {
            candidateCount: 0,
            fingerprintComputationCount: 0,
            indexLookupCount: 0,
            equivalenceCheckCount: 0,
            indexMaintenanceCount: 0,
            replacementCount: 0
        }
    };
}

function createStreamSampleBaseBucket(): StreamSampleBaseBucket {
    return {
        identityless: createStreamSampleGroupHeap(),
        identities: new Map(),
        fingerprints: new Map()
    };
}

function createStreamSampleFingerprintIndexes(): StreamSampleFingerprintIndexes {
    return {
        identityless: createStreamSampleGroupHeap(),
        identityBearing: createStreamSampleGroupHeap(),
        nestedIdentity: createStreamSampleGroupHeap(),
        nonNestedIdentity: createStreamSampleGroupHeap(),
        nonNestedIdentityBySource: new Map()
    };
}

function toPreparedStreamSampleCandidate(candidate: StreamTimingSampleCandidate): PreparedStreamTimingSampleCandidate {
    return {
        candidate,
        baseKey: toStreamSampleBaseKey(candidate.sample),
        fingerprint: toStreamSampleFingerprint(candidate.sample)
    };
}

function registerStreamSampleGroup(
    bucket: StreamSampleBaseBucket,
    group: IndexedStreamSampleGroup,
    work: StreamSampleIndexWork
): void {
    const { sample, sourcePriority } = group.prepared.candidate;
    const fingerprintIndexes = bucket.fingerprints.get(group.prepared.fingerprint) ??
        createStreamSampleFingerprintIndexes();
    bucket.fingerprints.set(group.prepared.fingerprint, fingerprintIndexes);
    if (!sample.identityKey) {
        pushIndexedStreamSampleGroup([bucket.identityless, fingerprintIndexes.identityless], group, work);
        return;
    }
    const identityHeap = bucket.identities.get(sample.identityKey) ?? createStreamSampleGroupHeap();
    bucket.identities.set(sample.identityKey, identityHeap);
    if (sample.nested) {
        pushIndexedStreamSampleGroup(
            [identityHeap, fingerprintIndexes.identityBearing, fingerprintIndexes.nestedIdentity],
            group,
            work
        );
        return;
    }
    const sourceHeap = fingerprintIndexes.nonNestedIdentityBySource.get(sourcePriority) ??
        createStreamSampleGroupHeap();
    fingerprintIndexes.nonNestedIdentityBySource.set(sourcePriority, sourceHeap);
    pushIndexedStreamSampleGroup(
        [identityHeap, fingerprintIndexes.identityBearing, fingerprintIndexes.nonNestedIdentity, sourceHeap],
        group,
        work
    );
}

function pushIndexedStreamSampleGroup(
    heaps: readonly IndexedStreamSampleGroupHeap[],
    group: IndexedStreamSampleGroup,
    work: StreamSampleIndexWork
): void {
    for (const heap of heaps) {
        pushStreamSampleGroup(heap, group);
        work.indexMaintenanceCount += 1;
    }
}

/** Every candidate heap counts as one index lookup, whether or not the bucket holds it. */
function removeStaleCandidateHeapEntries(
    heaps: readonly (IndexedStreamSampleGroupHeap | undefined)[],
    work: StreamSampleIndexWork
): void {
    for (const heap of heaps) {
        work.indexLookupCount += 1;
        if (heap !== undefined) {
            work.indexMaintenanceCount += removeStaleStreamSampleGroupEntries(heap);
        }
    }
}

/** The earliest oldest group of the candidate heaps that is the same stream execution; the heaps hold no stale top entry. */
function resolveEquivalentStreamSampleGroup(
    heaps: readonly (IndexedStreamSampleGroupHeap | undefined)[],
    prepared: PreparedStreamTimingSampleCandidate
): StreamSampleGroupResolution {
    const oldestGroups = new Set<IndexedStreamSampleGroup>();
    for (const heap of heaps) {
        const group = heap === undefined ? undefined : getOldestStreamSampleGroup(heap);
        if (group) {
            oldestGroups.add(group);
        }
    }
    let earliest: IndexedStreamSampleGroup | undefined;
    for (const group of oldestGroups) {
        const crossSource = group.prepared.candidate.sourcePriority !== prepared.candidate.sourcePriority;
        if (
            isSameStreamExecution(group.prepared, prepared, crossSource) &&
            (!earliest || group.insertionIndex < earliest.insertionIndex)
        ) {
            earliest = group;
        }
    }
    return { group: earliest, checkedGroupCount: oldestGroups.size };
}

/** Each heap holds the oldest group a candidate may be the same execution as; absent heaps still count a lookup. */
function toCandidateHeaps(
    bucket: StreamSampleBaseBucket,
    prepared: PreparedStreamTimingSampleCandidate
): readonly (IndexedStreamSampleGroupHeap | undefined)[] {
    const { sample, sourcePriority } = prepared.candidate;
    const fingerprintIndexes = bucket.fingerprints.get(prepared.fingerprint);
    if (!sample.identityKey) {
        return [bucket.identityless, fingerprintIndexes?.identityBearing];
    }
    const identityHeaps = [bucket.identities.get(sample.identityKey), fingerprintIndexes?.identityless];
    if (sample.nested) {
        return [...identityHeaps, fingerprintIndexes?.nonNestedIdentity];
    }
    // This internal index has six fixed producer priorities: four event tiers,
    // the control snapshot, and JSONL. Only one heap minimum is read per tier.
    const otherSourceHeaps = [...(fingerprintIndexes?.nonNestedIdentityBySource ?? [])]
        .filter(([indexedSourcePriority]) => indexedSourcePriority !== sourcePriority)
        .map(([, sourceHeap]) => sourceHeap);
    return [...identityHeaps, fingerprintIndexes?.nestedIdentity, ...otherSourceHeaps];
}

function computeStreamSampleCandidateOrder(
    left: StreamTimingSampleCandidate,
    right: StreamTimingSampleCandidate
): number {
    const terminalPriority = Number(left.sample.completeness === 'terminal') -
        Number(right.sample.completeness === 'terminal');
    return terminalPriority ||
        toStreamSampleEvidenceScore(left.sample) - toStreamSampleEvidenceScore(right.sample) ||
        left.sourcePriority - right.sourcePriority ||
        left.index - right.index;
}

function toStreamSampleEvidenceScore(sample: StreamTimingSample): number {
    const { summary } = sample;
    return (summary.thresholdFailureCount > 0 ? 1_000_000 : 0) +
        (sample.failed ? 500_000 : 0) +
        (summary.completedFrames ?? 0) * 10_000 +
        (summary.scheduledFrames ?? 0) * 1_000 +
        (summary.plannedFrames ?? 0) * 100 +
        summary.observations.length;
}

function toStreamSampleKey(prepared: PreparedStreamTimingSampleCandidate): string {
    const { identityKey } = prepared.candidate.sample;
    return identityKey ? `${prepared.baseKey}:${identityKey}` : prepared.baseKey;
}

function isSameStreamExecution(
    left: PreparedStreamTimingSampleCandidate,
    right: PreparedStreamTimingSampleCandidate,
    crossSource: boolean
): boolean {
    if (left.baseKey !== right.baseKey) {
        return false;
    }
    const leftSample = left.candidate.sample;
    const rightSample = right.candidate.sample;
    const sameFingerprint = left.fingerprint === right.fingerprint;
    if (!leftSample.identityKey || !rightSample.identityKey) {
        return (!leftSample.identityKey && !rightSample.identityKey) || sameFingerprint;
    }
    if (leftSample.identityKey === rightSample.identityKey) {
        return true;
    }
    if (leftSample.nested && rightSample.nested) {
        return false;
    }
    return !leftSample.nested && !rightSample.nested ? crossSource && sameFingerprint : sameFingerprint;
}

function toStreamSampleBaseKey(sample: StreamTimingSample): string {
    return `${sample.agentId ?? 'unknown-agent'}:${sample.commandId ?? sample.summary.commandId ?? 'unknown-stream'}`;
}

function toStreamSampleFingerprint(sample: StreamTimingSample): string {
    const { summary } = sample;
    return JSON.stringify({
        plannedFrames: summary.plannedFrames,
        scheduledFrames: summary.scheduledFrames,
        attemptedFrames: summary.attemptedFrames,
        completedFrames: summary.completedFrames,
        failedFrames: summary.failedFrames,
        droppedFrames: summary.droppedFrames,
        inFlightLimitDropCount: computeStreamInFlightLimitDropCount(sample),
        backpressureCount: summary.backpressureCount,
        requestedRateHz: summary.requestedRateHz,
        achievedScheduleHz: summary.achievedScheduleHz,
        achievedCompletionHz: summary.achievedCompletionHz,
        pacing: {
            maxStartDriftMs: summary.maxStartDriftMs,
            lateFrameCount: summary.lateFrameCount
        },
        duration: summary.fingerprintText.duration,
        thresholdFailures: summary.fingerprintText.thresholdFailures,
        observations: summary.fingerprintText.observations
    });
}
