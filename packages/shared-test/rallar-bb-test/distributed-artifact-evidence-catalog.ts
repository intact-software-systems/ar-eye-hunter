import {
    MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES,
    MAX_DISTRIBUTED_ARTIFACT_TEXT_LIMIT,
    type DeriveDistributedArtifactEvidenceIndexInput,
    type DistributedArtifactEvidenceCatalog,
    type DistributedArtifactEvidenceCollections,
    type DistributedArtifactEvidenceEntry,
} from './distributed-artifact-evidence-contracts.ts';
import {
    deriveDistributedArtifactEvidenceSource,
    projectDistributedArtifactEvidenceIndex,
} from './distributed-artifact-evidence-index.ts';
import { compareEvidenceEntries } from './distributed-artifact-evidence-utils.ts';
import { prepareDistributedArtifactEvidenceCatalogAuthority } from
    './distributed-artifact-evidence-window.ts';

const CATALOG_DIGEST_BATCH_SIZE = 128;

type CatalogCandidate = Readonly<{
    entry: DistributedArtifactEvidenceEntry;
    digest: string;
    rawSearchValue?: string;
}>;

type MutableCatalogWork = {
    sourceEntriesVisited: number;
    canonicalDigestsComputed: number;
    exactRepeatsDropped: number;
    distinctEntries: number;
    peakCanonicalBatchSize: number;
    peakRetainedEntryReferences: number;
    sortedRetainedEntries: number;
    retainedModelDigests: number;
    haystacksBuilt: number;
    rawSearchAssociationReads: number;
    retainedRawSearchValues: number;
    maxRetainedRawSearchValueLength: number;
};

export type DistributedArtifactEvidenceCatalogWork = Readonly<MutableCatalogWork>;

const catalogWork = new WeakMap<object, DistributedArtifactEvidenceCatalogWork>();

export async function deriveDistributedArtifactEvidenceCollections(
    input: DeriveDistributedArtifactEvidenceIndexInput,
): Promise<DistributedArtifactEvidenceCollections> {
    const source = deriveDistributedArtifactEvidenceSource(input);
    const index = projectDistributedArtifactEvidenceIndex(input, source);
    const catalog = await createDistributedArtifactEvidenceCatalog(
        input,
        source.rawEntries,
    );
    return { index, catalog };
}

export async function deriveDistributedArtifactEvidenceCatalog(
    input: DeriveDistributedArtifactEvidenceIndexInput,
): Promise<DistributedArtifactEvidenceCatalog> {
    const source = deriveDistributedArtifactEvidenceSource(input);
    return createDistributedArtifactEvidenceCatalog(input, source.rawEntries);
}

/** Test-only structural work snapshot; deliberately excluded from the public barrel. */
export function distributedArtifactEvidenceCatalogWorkForTest(
    catalog: DistributedArtifactEvidenceCatalog,
): DistributedArtifactEvidenceCatalogWork {
    const work = catalogWork.get(catalog);
    if (!work) throw new Error('The evidence catalog has no work snapshot.');
    return { ...work };
}

export async function resolveDistributedArtifactEvidenceCatalogEntryIds(
    entries: readonly DistributedArtifactEvidenceEntry[],
): Promise<DistributedArtifactEvidenceEntry[]> {
    const resolved: DistributedArtifactEvidenceEntry[] = [];
    await visitDistinctCatalogEntries(entries, candidate => {
        resolved.push(candidate.entry);
    });
    return resolved;
}

async function createDistributedArtifactEvidenceCatalog(
    input: DeriveDistributedArtifactEvidenceIndexInput,
    sourceEntries: readonly DistributedArtifactEvidenceEntry[],
): Promise<DistributedArtifactEvidenceCatalog> {
    const work = emptyCatalogWork();
    const newest = new BoundedNewestCandidates(
        MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES,
    );
    let primaryAnalysisFailure: CatalogCandidate | undefined;
    let latestFallbackFailure: CatalogCandidate | undefined;
    let latestDiagnostic: CatalogCandidate | undefined;
    const rawSearchValue = createRawSearchValueResolver(input);

    await visitDistinctCatalogEntries(sourceEntries, candidate => {
        work.distinctEntries += 1;
        newest.add(candidate);
        const entry = candidate.entry;
        if (entry.id.startsWith('failure:analysis:')) {
            if (
                !primaryAnalysisFailure ||
                compareEvidenceEntries(entry, primaryAnalysisFailure.entry) < 0
            ) {
                primaryAnalysisFailure = candidate;
            }
            latestFallbackFailure = undefined;
        } else if (entry.kind === 'failure' && !primaryAnalysisFailure) {
            latestFallbackFailure = laterCandidate(latestFallbackFailure, candidate);
        }
        if (entry.kind === 'diagnostic') {
            latestDiagnostic = laterCandidate(latestDiagnostic, candidate);
        }
        work.peakRetainedEntryReferences = Math.max(
            work.peakRetainedEntryReferences,
            newest.size + Number(Boolean(primaryAnalysisFailure ?? latestFallbackFailure)) +
                Number(Boolean(latestDiagnostic)),
        );
    }, work, rawSearchValue);

    const primaryFailure = primaryAnalysisFailure ?? latestFallbackFailure;
    const retained = retainCatalogCandidates(
        newest.values(),
        primaryFailure,
        latestDiagnostic,
    );
    work.sortedRetainedEntries = retained.length;
    work.retainedModelDigests = retained.length;
    const entries = retained.map(candidate => candidate.entry);
    const catalog: DistributedArtifactEvidenceCatalog = {
        entries,
        totalEntries: work.distinctEntries,
        retainedEntryCount: entries.length,
        indexOmittedEntryCount: work.distinctEntries - entries.length,
        limit: MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES,
        ...(primaryFailure ? { primaryFailureId: primaryFailure.entry.id } : {}),
        ...(latestDiagnostic ? { latestDiagnosticId: latestDiagnostic.entry.id } : {}),
        producerCompaction: {
            status: 'unavailable',
            reason: 'no-distributed-producer-compaction-contract',
        },
    };
    const retainedRawSearchValues = retained.map(candidate =>
        candidate.rawSearchValue ?? ''
    );
    work.retainedRawSearchValues = retainedRawSearchValues.filter(Boolean).length;
    work.maxRetainedRawSearchValueLength = retainedRawSearchValues.reduce(
        (maximum, value) => Math.max(maximum, value.length),
        0,
    );
    await prepareDistributedArtifactEvidenceCatalogAuthority(catalog, {
        artifactIdentity: [
            input.analysis.artifactSchemaVersion ?? null,
            input.analysis.distributedRunId,
            input.analysis.controlRunId ?? null,
        ],
        modelValue: [
            work.distinctEntries,
            entries.length,
            work.distinctEntries - entries.length,
            retained.map(candidate => [candidate.entry.id, candidate.digest]),
        ],
        searchValues: retainedRawSearchValues,
    });
    work.haystacksBuilt = entries.length;
    catalogWork.set(catalog, Object.freeze({ ...work }));
    return catalog;
}

async function visitDistinctCatalogEntries(
    entries: readonly DistributedArtifactEvidenceEntry[],
    visit: (candidate: CatalogCandidate) => void,
    work?: MutableCatalogWork,
    rawSearchValue?: (entry: DistributedArtifactEvidenceEntry) => unknown,
): Promise<void> {
    const baseIds = new Set<string>();
    for (const entry of entries) baseIds.add(entry.id);
    const usedIds = new Set(baseIds);
    const digestsByBaseId = new Map<string, Set<string>>();

    for (let start = 0; start < entries.length; start += CATALOG_DIGEST_BATCH_SIZE) {
        const batch = entries.slice(start, start + CATALOG_DIGEST_BATCH_SIZE).map(entry => {
            const rawValue = rawSearchValue?.(entry);
            const boundedRawValue = boundedRawSearchValue(rawValue);
            if (work) work.rawSearchAssociationReads += 1;
            const canonicalEntry = canonicalEvidenceEntry(entry);
            return {
                entry,
                rawSearchValue: boundedRawValue,
                canonical: boundedRawValue
                    ? JSON.stringify([canonicalEntry, boundedRawValue])
                    : canonicalEntry,
            };
        });
        if (work) {
            work.sourceEntriesVisited += batch.length;
            work.peakCanonicalBatchSize = Math.max(
                work.peakCanonicalBatchSize,
                batch.length,
            );
        }
        const digests = await Promise.all(batch.map(item => canonicalDigest(item.canonical)));
        if (work) work.canonicalDigestsComputed += digests.length;

        for (let index = 0; index < batch.length; index += 1) {
            const item = batch[index];
            const digest = digests[index];
            if (!item || !digest) continue;
            let knownDigests = digestsByBaseId.get(item.entry.id);
            if (!knownDigests) {
                knownDigests = new Set();
                digestsByBaseId.set(item.entry.id, knownDigests);
            }
            if (knownDigests.has(digest)) {
                if (work) work.exactRepeatsDropped += 1;
                continue;
            }
            const isCollision = knownDigests.size > 0;
            knownDigests.add(digest);
            const resolvedEntry = isCollision
                ? { ...item.entry, id: collisionId(item.entry.id, digest, usedIds) }
                : item.entry;
            usedIds.add(resolvedEntry.id);
            visit({
                entry: resolvedEntry,
                digest,
                ...(item.rawSearchValue.length === 0
                    ? {}
                    : { rawSearchValue: item.rawSearchValue }),
            });
        }
    }
}

function collisionId(baseId: string, digest: string, usedIds: Set<string>): string {
    const prefix = `${baseId}:collision:${digest}`;
    let id = prefix;
    let collisionIndex = 1;
    while (usedIds.has(id)) {
        collisionIndex += 1;
        id = `${prefix}:${collisionIndex}`;
    }
    return id;
}

function retainCatalogCandidates(
    newestCandidates: readonly CatalogCandidate[],
    primaryFailure: CatalogCandidate | undefined,
    latestDiagnostic: CatalogCandidate | undefined,
): CatalogCandidate[] {
    const retained: CatalogCandidate[] = [];
    const retainedIds = new Set<string>();
    for (const anchor of [primaryFailure, latestDiagnostic]) {
        if (anchor && !retainedIds.has(anchor.entry.id)) {
            retained.push(anchor);
            retainedIds.add(anchor.entry.id);
        }
    }
    const newest = [...newestCandidates].sort(compareNewestCandidates);
    for (const candidate of newest) {
        if (retained.length >= MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES) break;
        if (!retainedIds.has(candidate.entry.id)) {
            retained.push(candidate);
            retainedIds.add(candidate.entry.id);
        }
    }
    return retained.sort((left, right) =>
        compareEvidenceEntries(left.entry, right.entry)
    );
}

function laterCandidate(
    current: CatalogCandidate | undefined,
    candidate: CatalogCandidate,
): CatalogCandidate {
    return !current || compareNewestCandidates(candidate, current) < 0
        ? candidate
        : current;
}

function compareNewestCandidates(left: CatalogCandidate, right: CatalogCandidate): number {
    return (right.entry.atEpochMs ?? Number.MIN_SAFE_INTEGER) -
            (left.entry.atEpochMs ?? Number.MIN_SAFE_INTEGER) ||
        compareEvidenceEntries(left.entry, right.entry);
}

function candidatePriority(left: CatalogCandidate, right: CatalogCandidate): number {
    return (left.entry.atEpochMs ?? Number.MIN_SAFE_INTEGER) -
            (right.entry.atEpochMs ?? Number.MIN_SAFE_INTEGER) ||
        -compareEvidenceEntries(left.entry, right.entry);
}

class BoundedNewestCandidates {
    readonly #heap: CatalogCandidate[] = [];

    constructor(readonly limit: number) {}

    get size(): number {
        return this.#heap.length;
    }

    add(candidate: CatalogCandidate): void {
        if (this.limit === 0) return;
        if (this.#heap.length < this.limit) {
            this.#heap.push(candidate);
            this.#bubbleUp(this.#heap.length - 1);
            return;
        }
        const worst = this.#heap[0];
        if (!worst || candidatePriority(candidate, worst) <= 0) return;
        this.#heap[0] = candidate;
        this.#siftDown(0);
    }

    values(): readonly CatalogCandidate[] {
        return this.#heap;
    }

    #bubbleUp(start: number): void {
        let index = start;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            const parentValue = this.#heap[parent];
            const value = this.#heap[index];
            if (!parentValue || !value || candidatePriority(value, parentValue) >= 0) break;
            this.#heap[parent] = value;
            this.#heap[index] = parentValue;
            index = parent;
        }
    }

    #siftDown(start: number): void {
        let index = start;
        while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            let worst = index;
            const leftValue = this.#heap[left];
            const worstValue = this.#heap[worst];
            if (leftValue && worstValue && candidatePriority(leftValue, worstValue) < 0) {
                worst = left;
            }
            const rightValue = this.#heap[right];
            const nextWorstValue = this.#heap[worst];
            if (
                rightValue && nextWorstValue &&
                candidatePriority(rightValue, nextWorstValue) < 0
            ) {
                worst = right;
            }
            if (worst === index) return;
            const value = this.#heap[index];
            const replacement = this.#heap[worst];
            if (!value || !replacement) return;
            this.#heap[index] = replacement;
            this.#heap[worst] = value;
            index = worst;
        }
    }
}

async function canonicalDigest(value: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(value),
    ));
    let binary = '';
    for (const byte of digest) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function canonicalEvidenceEntry(entry: DistributedArtifactEvidenceEntry): string {
    return JSON.stringify([
        entry.id, entry.kind, entry.sourceFile, entry.atEpochMs ?? null,
        entry.agentId ?? null, entry.agentIds ?? null, entry.recipeId ?? null,
        entry.commandId ?? null, entry.topic ?? null, entry.diagnosticType ?? null,
        entry.severity ?? null, entry.transport ?? null, entry.status ?? null,
        entry.category ?? null, entry.summary, entry.payloadSummary,
        entry.failureDetails
            ? [
                  entry.failureDetails.code ?? null,
                  entry.failureDetails.name ?? null,
                  entry.failureDetails.message ?? null,
                  entry.failureDetails.stack ?? null,
              ]
            : null,
    ]);
}

function createRawSearchValueResolver(
    input: DeriveDistributedArtifactEvidenceIndexInput,
): (entry: DistributedArtifactEvidenceEntry) => unknown {
    type Queue = { values: unknown[]; offset: number };
    const results = new Map<string, Queue>();
    for (const result of input.snapshots.controlRun.results) {
        appendRawSearchValue(results, evidenceSearchKey(
            result.agentId,
            result.commandId,
            result.result?.endedAtEpochMs,
        ), result);
    }
    const events = new Map<string, Queue>();
    for (const event of input.snapshots.controlRun.events) {
        appendRawSearchValue(events, evidenceSearchKey(
            event.agentId,
            event.commandId,
            event.atEpochMs,
        ), event.payload);
    }
    return entry => {
        const queue = entry.kind === 'result'
            ? results.get(evidenceSearchKey(
                entry.agentId,
                entry.commandId,
                entry.atEpochMs,
            ))
            : entry.kind === 'event' || entry.kind === 'diagnostic'
            ? events.get(evidenceSearchKey(
                entry.agentId,
                entry.commandId,
                entry.atEpochMs,
            ))
            : undefined;
        if (!queue) return undefined;
        const value = queue.values[queue.offset];
        queue.offset += 1;
        return value;
    };
}

function appendRawSearchValue(
    queues: Map<string, { values: unknown[]; offset: number }>,
    key: string,
    value: unknown,
): void {
    const queue = queues.get(key);
    if (queue) queue.values.push(value);
    else queues.set(key, { values: [value], offset: 0 });
}

function evidenceSearchKey(
    agentId: string | undefined,
    commandId: string | undefined,
    atEpochMs: number | undefined,
): string {
    return JSON.stringify([agentId ?? null, commandId ?? null, atEpochMs ?? null]);
}

function boundedRawSearchValue(value: unknown): string {
    if (value === undefined) return '';
    let encoded: string;
    try {
        encoded = JSON.stringify(value);
    } catch {
        encoded = String(value ?? '');
    }
    return encoded.slice(0, MAX_DISTRIBUTED_ARTIFACT_TEXT_LIMIT);
}

function emptyCatalogWork(): MutableCatalogWork {
    return {
        sourceEntriesVisited: 0,
        canonicalDigestsComputed: 0,
        exactRepeatsDropped: 0,
        distinctEntries: 0,
        peakCanonicalBatchSize: 0,
        peakRetainedEntryReferences: 0,
        sortedRetainedEntries: 0,
        retainedModelDigests: 0,
        haystacksBuilt: 0,
        rawSearchAssociationReads: 0,
        retainedRawSearchValues: 0,
        maxRetainedRawSearchValueLength: 0,
    };
}
