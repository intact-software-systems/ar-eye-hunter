import {
    DEFAULT_DISTRIBUTED_ARTIFACT_EVIDENCE_WINDOW_SIZE,
    MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_WINDOW_SIZE,
    type DistributedArtifactEvidenceCatalog,
    type DistributedArtifactEvidenceCursor,
    type DistributedArtifactEvidenceCursorRejectionCode,
    type DistributedArtifactEvidenceWindowRequest,
    type DistributedArtifactEvidenceWindowResult,
} from './distributed-artifact-evidence-contracts.ts';
import {
    compileDistributedArtifactEvidenceQuery,
    distributedArtifactEvidenceEntryMatches,
    distributedArtifactEvidenceQueryFingerprintValue,
    distributedArtifactEvidenceSearchHaystack,
} from './distributed-artifact-evidence-query.ts';
import { normalizedEvidenceText } from './distributed-artifact-evidence-utils.ts';

type MatchIndexCache = Readonly<{
    queryFingerprint: string;
    indices: Uint32Array;
    count: number;
}>;

type MutableWindowWork = {
    cursorVerificationAttempts: number;
    queryBuildCount: number;
    queryCacheHits: number;
    matchEvaluations: number;
    matchIndexWrites: number;
    windowIndexReads: number;
    peakMatchIndexCapacity: number;
};

export type DistributedArtifactEvidenceWindowWork = Readonly<MutableWindowWork>;

type CatalogAuthority = {
    artifactFingerprint: string;
    modelFingerprint: string;
    instanceId: string;
    key: CryptoKey;
    haystacks: readonly string[];
    matchIndexCache?: MatchIndexCache;
    work: MutableWindowWork;
};

type CursorPayload = Readonly<{
    v: 1;
    r: 'distributed-artifact-evidence/source-v1';
    a: string;
    m: string;
    i: string;
    q: string;
    s: number;
    p: number;
}>;

const authorities = new WeakMap<object, CatalogAuthority>();
let masterKeyPromise: Promise<CryptoKey> | undefined;

export async function prepareDistributedArtifactEvidenceCatalogAuthority(
    catalog: DistributedArtifactEvidenceCatalog,
    input: Readonly<{
        artifactIdentity: readonly unknown[];
        modelValue: readonly unknown[];
        searchValues?: readonly string[];
    }>,
): Promise<void> {
    const artifactFingerprint = await digestCanonical(input.artifactIdentity);
    const modelFingerprint = await digestCanonical(input.modelValue);
    const instanceId = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const key = await deriveCursorKey(artifactFingerprint, modelFingerprint, instanceId);
    authorities.set(catalog, {
        artifactFingerprint,
        modelFingerprint,
        instanceId,
        key,
        haystacks: catalog.entries.map((entry, index) => [
            distributedArtifactEvidenceSearchHaystack(entry),
            normalizedEvidenceText(input.searchValues?.[index]),
        ].filter(Boolean).join(' ')),
        work: emptyWindowWork(),
    });
}

/** Test-only work snapshot; deliberately excluded from the public evidence barrel. */
export function distributedArtifactEvidenceWindowWorkForTest(
    catalog: DistributedArtifactEvidenceCatalog,
): DistributedArtifactEvidenceWindowWork {
    const authority = authorities.get(catalog);
    if (!authority) throw new Error('The evidence catalog is no longer active.');
    return { ...authority.work };
}

/** Test-only reset; also clears the single-query match-index cache. */
export function resetDistributedArtifactEvidenceWindowWorkForTest(
    catalog: DistributedArtifactEvidenceCatalog,
): void {
    const authority = authorities.get(catalog);
    if (!authority) throw new Error('The evidence catalog is no longer active.');
    authority.work = emptyWindowWork();
    authority.matchIndexCache = undefined;
}

export async function searchDistributedArtifactEvidenceWindow(
    catalog: DistributedArtifactEvidenceCatalog,
    request: DistributedArtifactEvidenceWindowRequest = {},
): Promise<DistributedArtifactEvidenceWindowResult> {
    const authority = authorities.get(catalog);
    if (!authority) {
        return rejected('cursor-stale-model', 'The evidence catalog is no longer active.');
    }
    const parsedCursor = request.cursor === undefined
        ? undefined
        : parseCursor(request.cursor);
    if (parsedCursor && !parsedCursor.ok) return parsedCursor.result;
    const cursorPayload = parsedCursor?.ok ? parsedCursor.payload : undefined;
    const windowSize = boundedWindowSize(
        request.windowSize ?? cursorPayload?.s,
    );
    const compiled = compileDistributedArtifactEvidenceQuery(request.query ?? {});
    const queryValue = distributedArtifactEvidenceQueryFingerprintValue(compiled);
    const matchQueryFingerprint = await digestCanonical(queryValue);
    const cursorQueryFingerprint = await digestCanonical([
        queryValue,
        windowSize,
    ]);
    let offset = 0;

    if (cursorPayload && parsedCursor?.ok) {
        authority.work.cursorVerificationAttempts += 1;
        const candidateKey = await deriveCursorKey(
            cursorPayload.a,
            cursorPayload.m,
            cursorPayload.i,
        );
        const verified = await crypto.subtle.verify(
            'HMAC', candidateKey, copiedArrayBuffer(parsedCursor.signature),
            new TextEncoder().encode(parsedCursor.body),
        );
        if (!verified) {
            return rejected('cursor-tampered', 'The evidence cursor failed its integrity check.');
        }
        if (cursorPayload.a !== authority.artifactFingerprint) {
            return rejected('cursor-foreign-artifact', 'The cursor belongs to another artifact.');
        }
        if (
            cursorPayload.m !== authority.modelFingerprint ||
            cursorPayload.i !== authority.instanceId
        ) {
            return rejected('cursor-stale-model', 'The cursor belongs to a stale evidence model.');
        }
        if (
            cursorPayload.q !== cursorQueryFingerprint ||
            cursorPayload.s !== windowSize
        ) {
            return rejected('cursor-query-mismatch', 'The cursor does not match the active evidence query.');
        }
        offset = cursorPayload.p;
    }

    const matches = matchingEntryIndexes(
        catalog,
        authority,
        compiled,
        matchQueryFingerprint,
    );
    if (cursorPayload && parsedCursor?.ok) {
        if (
            cursorPayload.p < 0 || !Number.isSafeInteger(cursorPayload.p) ||
            (matches.count === 0 ? cursorPayload.p !== 0 : cursorPayload.p >= matches.count)
        ) {
            return rejected('cursor-out-of-range', 'The cursor points outside the matching evidence.');
        }
    }

    const renderedEntryCount = Math.min(windowSize, matches.count - offset);
    const entries = Array.from({ length: renderedEntryCount }, (_, index) => {
        const catalogIndex = matches.indices[offset + index];
        const entry = catalogIndex === undefined
            ? undefined
            : catalog.entries[catalogIndex];
        if (!entry) throw new Error('Evidence match index points outside the catalog.');
        authority.work.windowIndexReads += 1;
        return entry;
    });
    const previousOffset = offset > 0 ? Math.max(0, offset - windowSize) : undefined;
    const nextOffset = offset + entries.length < matches.count
        ? offset + windowSize
        : undefined;
    const [previousCursor, nextCursor] = await Promise.all([
        previousOffset === undefined
            ? undefined
            : issueCursor(authority, cursorQueryFingerprint, windowSize, previousOffset),
        nextOffset === undefined
            ? undefined
            : issueCursor(authority, cursorQueryFingerprint, windowSize, nextOffset),
    ]);
    return {
        ok: true,
        window: {
            entries,
            rangeStart: entries.length > 0 ? offset + 1 : 0,
            rangeEnd: entries.length > 0 ? offset + entries.length : 0,
            ...(previousCursor ? { previousCursor } : {}),
            ...(nextCursor ? { nextCursor } : {}),
            counts: {
                totalEntries: catalog.totalEntries,
                indexedEntries: catalog.retainedEntryCount,
                indexOmittedEntries: catalog.indexOmittedEntryCount,
                retainedMatches: matches.count,
                queryExcludedEntries: catalog.retainedEntryCount - matches.count,
                renderedMatches: entries.length,
                renderOmittedMatches: matches.count - entries.length,
            },
            totalMatchesIsComplete: catalog.indexOmittedEntryCount === 0,
            windowSize,
        },
    };
}

function matchingEntryIndexes(
    catalog: DistributedArtifactEvidenceCatalog,
    authority: CatalogAuthority,
    compiled: ReturnType<typeof compileDistributedArtifactEvidenceQuery>,
    queryFingerprint: string,
): MatchIndexCache {
    if (authority.matchIndexCache?.queryFingerprint === queryFingerprint) {
        authority.work.queryCacheHits += 1;
        return authority.matchIndexCache;
    }
    authority.work.queryBuildCount += 1;
    const indices = new Uint32Array(catalog.entries.length);
    authority.work.peakMatchIndexCapacity = Math.max(
        authority.work.peakMatchIndexCapacity,
        indices.length,
    );
    let count = 0;
    for (let index = 0; index < catalog.entries.length; index += 1) {
        const entry = catalog.entries[index];
        if (!entry) continue;
        authority.work.matchEvaluations += 1;
        if (!distributedArtifactEvidenceEntryMatches(
            entry,
            compiled,
            authority.haystacks[index],
        )) continue;
        indices[count] = index;
        count += 1;
        authority.work.matchIndexWrites += 1;
    }
    const cache = { queryFingerprint, indices, count };
    authority.matchIndexCache = cache;
    return cache;
}

/** Test-only cursor issuer; deliberately excluded from the public evidence barrel. */
export async function issueDistributedArtifactEvidenceCursorForTest(
    catalog: DistributedArtifactEvidenceCatalog,
    input: Readonly<{
        query?: DistributedArtifactEvidenceWindowRequest['query'];
        windowSize?: number;
        offset: number;
    }>,
): Promise<DistributedArtifactEvidenceCursor> {
    const authority = authorities.get(catalog);
    if (!authority) throw new Error('The evidence catalog is no longer active.');
    const windowSize = boundedWindowSize(input.windowSize);
    const compiled = compileDistributedArtifactEvidenceQuery(input.query ?? {});
    const queryFingerprint = await digestCanonical([
        distributedArtifactEvidenceQueryFingerprintValue(compiled),
        windowSize,
    ]);
    return issueCursor(authority, queryFingerprint, windowSize, input.offset);
}

async function issueCursor(
    authority: CatalogAuthority,
    queryFingerprint: string,
    windowSize: number,
    offset: number,
): Promise<DistributedArtifactEvidenceCursor> {
    const payload: CursorPayload = {
        v: 1,
        r: 'distributed-artifact-evidence/source-v1',
        a: authority.artifactFingerprint,
        m: authority.modelFingerprint,
        i: authority.instanceId,
        q: queryFingerprint,
        s: windowSize,
        p: offset,
    };
    const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const signature = new Uint8Array(await crypto.subtle.sign(
        'HMAC', authority.key, new TextEncoder().encode(body),
    ));
    return `${body}.${bytesToBase64Url(signature)}` as DistributedArtifactEvidenceCursor;
}

function parseCursor(cursor: string):
    | Readonly<{ ok: true; payload: CursorPayload; body: string; signature: Uint8Array }>
    | Readonly<{ ok: false; result: DistributedArtifactEvidenceWindowResult }> {
    try {
        const parts = cursor.split('.');
        if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('parts');
        const value: unknown = JSON.parse(
            new TextDecoder().decode(base64UrlToBytes(parts[0])),
        );
        if (!isCursorPayload(value)) throw new Error('schema');
        const signature = base64UrlToBytes(parts[1]);
        if (signature.length !== 32) throw new Error('signature');
        return { ok: true, payload: value, body: parts[0], signature };
    } catch {
        return {
            ok: false,
            result: rejected('cursor-malformed', 'The evidence cursor is malformed.'),
        };
    }
}

function isCursorPayload(value: unknown): value is CursorPayload {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return record.v === 1 &&
        record.r === 'distributed-artifact-evidence/source-v1' &&
        typeof record.a === 'string' && typeof record.m === 'string' &&
        typeof record.i === 'string' && typeof record.q === 'string' &&
        Number.isSafeInteger(record.s) && Number(record.s) >= 1 &&
        Number(record.s) <= MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_WINDOW_SIZE &&
        Number.isSafeInteger(record.p);
}

function boundedWindowSize(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
        return DEFAULT_DISTRIBUTED_ARTIFACT_EVIDENCE_WINDOW_SIZE;
    }
    return Math.min(
        MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_WINDOW_SIZE,
        Math.max(1, Math.floor(value)),
    );
}

async function digestCanonical(value: unknown): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(JSON.stringify(value)),
    );
    return bytesToBase64Url(new Uint8Array(digest));
}

async function deriveCursorKey(
    artifactFingerprint: string,
    modelFingerprint: string,
    instanceId: string,
): Promise<CryptoKey> {
    const master = await cursorMasterKey();
    const material = new Uint8Array(await crypto.subtle.sign(
        'HMAC',
        master,
        new TextEncoder().encode(JSON.stringify([
            artifactFingerprint,
            modelFingerprint,
            instanceId,
        ])),
    ));
    return crypto.subtle.importKey(
        'raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
}

function cursorMasterKey(): Promise<CryptoKey> {
    masterKeyPromise ??= crypto.subtle.importKey(
        'raw',
        crypto.getRandomValues(new Uint8Array(32)),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    return masterKeyPromise;
}

function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('base64url');
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

function rejected(
    code: DistributedArtifactEvidenceCursorRejectionCode,
    message: string,
): DistributedArtifactEvidenceWindowResult {
    return { ok: false, rejection: { code, message } };
}

function emptyWindowWork(): MutableWindowWork {
    return {
        cursorVerificationAttempts: 0,
        queryBuildCount: 0,
        queryCacheHits: 0,
        matchEvaluations: 0,
        matchIndexWrites: 0,
        windowIndexReads: 0,
        peakMatchIndexCapacity: 0,
    };
}
