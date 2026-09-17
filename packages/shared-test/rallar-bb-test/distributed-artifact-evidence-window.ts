import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import {
    DEFAULT_DISTRIBUTED_ARTIFACT_EVIDENCE_WINDOW_SIZE,
    MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES,
    MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_WINDOW_SIZE,
    type ComputeDistributedArtifactEvidenceIndexInput,
    type DistributedArtifactEvidenceCatalog,
    type DistributedArtifactEvidenceCollections,
    type DistributedArtifactEvidenceCursorRejection,
    type DistributedArtifactEvidenceCursorRejectionCode,
    type DistributedArtifactEvidenceEntry,
    type DistributedArtifactEvidenceWindowAccepted,
    type DistributedArtifactEvidenceWindowCounts,
    type DistributedArtifactEvidenceWindowRequest,
    type DistributedArtifactEvidenceWindowResult
} from './distributed-artifact-evidence-contracts.ts';
import {
    compileDistributedArtifactEvidenceQuery,
    distributedArtifactEvidenceEntryMatches,
    distributedArtifactEvidenceQueryFingerprintValue,
    distributedArtifactEvidenceSearchHaystack,
    type CompiledDistributedArtifactEvidenceQuery
} from './distributed-artifact-evidence-query.ts';
import {
    BoundedNewestCandidates,
    CatalogAnchorSelection,
    computeRetainedCatalogCandidates,
    type CatalogAnchors
} from './distributed-artifact-evidence/catalog-candidate-retention.ts';
import { computeCanonicalDigest, toBase64Url } from './distributed-artifact-evidence/compute-canonical-digest.ts';
import {
    computeDistributedArtifactEvidenceIndexFromSource,
    computeDistributedArtifactEvidenceSource
} from './distributed-artifact-evidence/compute-distributed-artifact-evidence-source.ts';
import { createRawSearchValueReader } from './distributed-artifact-evidence/create-raw-search-value-reader.ts';
import {
    computeEvidenceCursorKey,
    createEvidenceCursor,
    decodeEvidenceCursor,
    type DecodedEvidenceCursor,
    type EvidenceCursorIdentity
} from './distributed-artifact-evidence/evidence-window-cursor.ts';
import {
    resolveDistinctCatalogCandidates,
    type CatalogCandidate
} from './distributed-artifact-evidence/resolve-distinct-catalog-candidates.ts';
import { toNormalizedEvidenceText } from './distributed-artifact-evidence/to-normalized-evidence-text.ts';

interface CatalogAuthorityInput {
    readonly artifactIdentity: readonly ApiJsonValue[];
    readonly modelValue: readonly ApiJsonValue[];
    /** One raw search text per catalog entry, empty when the entry has none. */
    readonly searchValues: readonly string[];
}

interface MatchIndex {
    readonly queryFingerprint: string;
    readonly indices: Uint32Array;
    readonly count: number;
}

interface WindowQuery {
    readonly compiled: CompiledDistributedArtifactEvidenceQuery;
    readonly matchFingerprint: string;
    /** Binds a cursor to its query and window size. */
    readonly cursorFingerprint: string;
    readonly windowSize: number;
}

interface EvidenceWindowSource {
    readonly catalog: DistributedArtifactEvidenceCatalog;
    readonly authority: EvidenceCatalogAuthority;
    readonly query: WindowQuery;
    readonly matches: MatchIndex;
    readonly offset: number;
}

/** A catalog's authority holds its signing key, so it stays in this module and never travels with the catalog value. */
const authorities = new WeakMap<DistributedArtifactEvidenceCatalog, EvidenceCatalogAuthority>();

export async function computeDistributedArtifactEvidenceCollections(
    input: ComputeDistributedArtifactEvidenceIndexInput
): Promise<DistributedArtifactEvidenceCollections> {
    const source = computeDistributedArtifactEvidenceSource(input);
    const index = computeDistributedArtifactEvidenceIndexFromSource(input, source);
    const catalog = await createDistributedArtifactEvidenceCatalog(input, source.rawEntries);
    return { index, catalog };
}

/**
 * A cursor is honoured only by the catalog instance that issued it, for the same query and window size; a catalog
 * that has been replaced rejects it as stale.
 */
export async function searchDistributedArtifactEvidenceWindow(
    catalog: DistributedArtifactEvidenceCatalog,
    request: DistributedArtifactEvidenceWindowRequest
): Promise<DistributedArtifactEvidenceWindowResult> {
    const authority = authorities.get(catalog);
    if (!authority) {
        return toWindowRejection('cursor-stale-model', 'The evidence catalog is no longer active.');
    }
    const cursor = request.cursor === undefined ? undefined : decodeEvidenceCursor(request.cursor);
    if (request.cursor !== undefined && cursor === undefined) {
        return toWindowRejection('cursor-malformed', 'The evidence cursor is malformed.');
    }
    const query = await computeWindowQuery(request, cursor);
    if (cursor === undefined) {
        const matches = authority.resolveMatchIndex(catalog, query.compiled, query.matchFingerprint);
        return createEvidenceWindow({ catalog, authority, query, matches, offset: 0 });
    }
    const rejection = await computeCursorRejection(cursor, authority, query);
    if (rejection) {
        return { ok: false, rejection };
    }
    const matches = authority.resolveMatchIndex(catalog, query.compiled, query.matchFingerprint);
    const { offset } = cursor.position;
    if (offset < 0 || (matches.count === 0 ? offset !== 0 : offset >= matches.count)) {
        return toWindowRejection('cursor-out-of-range', 'The cursor points outside the matching evidence.');
    }
    return createEvidenceWindow({ catalog, authority, query, matches, offset });
}

/** The catalog reads every source row once, keeps its anchors and newest rows, and opens its window authority. */
async function createDistributedArtifactEvidenceCatalog(
    input: ComputeDistributedArtifactEvidenceIndexInput,
    sourceEntries: readonly DistributedArtifactEvidenceEntry[]
): Promise<DistributedArtifactEvidenceCatalog> {
    const newest = new BoundedNewestCandidates(MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES);
    const anchorSelection = new CatalogAnchorSelection(
        input.analysis.ok ? undefined : input.analysis.failure.commandId
    );
    const distinctEntryCount = await resolveDistinctCatalogCandidates({
        entries: sourceEntries,
        readRawSearchValue: createRawSearchValueReader(input.snapshots),
        onCandidate: (candidate) => {
            newest.add(candidate);
            anchorSelection.add(candidate);
        }
    });
    const anchors = anchorSelection.toAnchors();
    const retained = computeRetainedCatalogCandidates(newest.getCandidates(), anchors);
    const catalog = toDistributedArtifactEvidenceCatalog(retained, anchors, distinctEntryCount);
    await initCatalogAuthority(catalog, {
        artifactIdentity: [
            input.analysis.artifactSchemaVersion ?? null,
            input.analysis.distributedRunId,
            input.analysis.controlRunId ?? null
        ],
        modelValue: [
            catalog.totalEntries,
            catalog.retainedEntryCount,
            catalog.indexOmittedEntryCount,
            retained.map((candidate) => [candidate.entry.id, candidate.digest])
        ],
        searchValues: retained.map((candidate) => candidate.rawSearchValue ?? '')
    });
    return catalog;
}

function toDistributedArtifactEvidenceCatalog(
    retained: readonly CatalogCandidate[],
    anchors: CatalogAnchors,
    distinctEntryCount: number
): DistributedArtifactEvidenceCatalog {
    const { primaryFailure, latestDiagnostic } = anchors;
    const entries = retained.map((candidate) => candidate.entry);
    return {
        entries,
        totalEntries: distinctEntryCount,
        retainedEntryCount: entries.length,
        indexOmittedEntryCount: distinctEntryCount - entries.length,
        limit: MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES,
        ...(primaryFailure ? { primaryFailureId: primaryFailure.entry.id } : {}),
        ...(latestDiagnostic ? { latestDiagnosticId: latestDiagnostic.entry.id } : {}),
        producerCompaction: { status: 'unavailable', reason: 'no-distributed-producer-compaction-contract' }
    };
}

async function initCatalogAuthority(
    catalog: DistributedArtifactEvidenceCatalog,
    input: CatalogAuthorityInput
): Promise<void> {
    const identity: EvidenceCursorIdentity = {
        artifactFingerprint: await computeCanonicalDigest(JSON.stringify(input.artifactIdentity)),
        modelFingerprint: await computeCanonicalDigest(JSON.stringify(input.modelValue)),
        instanceId: toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
    };
    const haystacks = catalog.entries.map((entry, index) =>
        [
            distributedArtifactEvidenceSearchHaystack(entry),
            toNormalizedEvidenceText(input.searchValues[index])
        ].filter(Boolean).join(' ')
    );
    authorities.set(
        catalog,
        new EvidenceCatalogAuthority(identity, await computeEvidenceCursorKey(identity), haystacks)
    );
}

/** A cursor's window size wins over the request's unless the request names one. */
async function computeWindowQuery(
    request: DistributedArtifactEvidenceWindowRequest,
    cursor: DecodedEvidenceCursor | undefined
): Promise<WindowQuery> {
    const windowSize = resolveWindowSize(request.windowSize ?? cursor?.position.windowSize);
    const compiled = compileDistributedArtifactEvidenceQuery(request.query ?? {});
    const fingerprint = distributedArtifactEvidenceQueryFingerprintValue(compiled);
    return {
        compiled,
        matchFingerprint: await computeCanonicalDigest(JSON.stringify(fingerprint)),
        cursorFingerprint: await computeCanonicalDigest(JSON.stringify([fingerprint, windowSize])),
        windowSize
    };
}

/** Undefined when the cursor is authentic and belongs to this catalog instance, query and window size. */
async function computeCursorRejection(
    cursor: DecodedEvidenceCursor,
    authority: EvidenceCatalogAuthority,
    query: WindowQuery
): Promise<DistributedArtifactEvidenceCursorRejection | undefined> {
    const { identity, position } = cursor;
    const key = await computeEvidenceCursorKey(identity);
    if (!await crypto.subtle.verify('HMAC', key, cursor.signature, new TextEncoder().encode(cursor.body))) {
        return { code: 'cursor-tampered', message: 'The evidence cursor failed its integrity check.' };
    }
    if (identity.artifactFingerprint !== authority.identity.artifactFingerprint) {
        return { code: 'cursor-foreign-artifact', message: 'The cursor belongs to another artifact.' };
    }
    if (
        identity.modelFingerprint !== authority.identity.modelFingerprint ||
        identity.instanceId !== authority.identity.instanceId
    ) {
        return { code: 'cursor-stale-model', message: 'The cursor belongs to a stale evidence model.' };
    }
    return position.queryFingerprint !== query.cursorFingerprint || position.windowSize !== query.windowSize
        ? { code: 'cursor-query-mismatch', message: 'The cursor does not match the active evidence query.' }
        : undefined;
}

async function createEvidenceWindow(source: EvidenceWindowSource): Promise<DistributedArtifactEvidenceWindowAccepted> {
    const { catalog, authority, query, matches, offset } = source;
    const { windowSize } = query;
    const entries = Array.from({ length: Math.min(windowSize, matches.count - offset) }, (_, index) => {
        const catalogIndex = matches.indices[offset + index];
        const entry = catalogIndex === undefined ? undefined : catalog.entries[catalogIndex];
        assertMatchedCatalogEntry(entry);
        return entry;
    });
    const previousOffset = offset > 0 ? Math.max(0, offset - windowSize) : undefined;
    const nextOffset = offset + entries.length < matches.count ? offset + windowSize : undefined;
    const createWindowCursor = (cursorOffset: number | undefined) =>
        cursorOffset === undefined ? undefined : createEvidenceCursor(authority.identity, authority.key, {
            queryFingerprint: query.cursorFingerprint,
            windowSize,
            offset: cursorOffset
        });
    const [previousCursor, nextCursor] = await Promise.all([
        createWindowCursor(previousOffset),
        createWindowCursor(nextOffset)
    ]);
    return {
        ok: true,
        window: {
            entries,
            rangeStart: entries.length > 0 ? offset + 1 : 0,
            rangeEnd: entries.length > 0 ? offset + entries.length : 0,
            ...(previousCursor ? { previousCursor } : {}),
            ...(nextCursor ? { nextCursor } : {}),
            counts: toWindowCounts(catalog, matches, entries.length),
            totalMatchesIsComplete: catalog.indexOmittedEntryCount === 0,
            windowSize
        }
    };
}

function toWindowCounts(
    catalog: DistributedArtifactEvidenceCatalog,
    matches: MatchIndex,
    renderedMatches: number
): DistributedArtifactEvidenceWindowCounts {
    return {
        totalEntries: catalog.totalEntries,
        indexedEntries: catalog.retainedEntryCount,
        indexOmittedEntries: catalog.indexOmittedEntryCount,
        retainedMatches: matches.count,
        queryExcludedEntries: catalog.retainedEntryCount - matches.count,
        renderedMatches,
        renderOmittedMatches: matches.count - renderedMatches
    };
}

/** Owns a catalog's cursor identity and signing key, and the match index of the last query it windowed. */
class EvidenceCatalogAuthority {
    readonly identity: EvidenceCursorIdentity;

    readonly key: CryptoKey;

    readonly #haystacks: readonly string[];

    /** Undefined until a window matches a query; then the index of the most recent query. */
    #matchIndex: MatchIndex | undefined;

    constructor(identity: EvidenceCursorIdentity, key: CryptoKey, haystacks: readonly string[]) {
        this.identity = identity;
        this.key = key;
        this.#haystacks = haystacks;
    }

    /** Paging through one query reuses its match index instead of matching the catalog again. */
    resolveMatchIndex(
        catalog: DistributedArtifactEvidenceCatalog,
        compiled: CompiledDistributedArtifactEvidenceQuery,
        queryFingerprint: string
    ): MatchIndex {
        if (this.#matchIndex?.queryFingerprint === queryFingerprint) {
            return this.#matchIndex;
        }
        const indices = new Uint32Array(catalog.entries.length);
        let count = 0;
        catalog.entries.forEach((entry, index) => {
            if (distributedArtifactEvidenceEntryMatches(entry, compiled, this.#haystacks[index])) {
                indices[count] = index;
                count += 1;
            }
        });
        this.#matchIndex = { queryFingerprint, indices, count };
        return this.#matchIndex;
    }
}

function resolveWindowSize(windowSize: number | undefined): number {
    if (windowSize === undefined || !Number.isFinite(windowSize)) {
        return DEFAULT_DISTRIBUTED_ARTIFACT_EVIDENCE_WINDOW_SIZE;
    }
    return Math.min(MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_WINDOW_SIZE, Math.max(1, Math.floor(windowSize)));
}

function toWindowRejection(
    code: DistributedArtifactEvidenceCursorRejectionCode,
    message: string
): DistributedArtifactEvidenceWindowResult {
    return { ok: false, rejection: { code, message } };
}

function assertMatchedCatalogEntry(
    entry: DistributedArtifactEvidenceEntry | undefined
): asserts entry is DistributedArtifactEvidenceEntry {
    if (!entry) {
        throw new Error('Evidence match index points outside the catalog.');
    }
}
