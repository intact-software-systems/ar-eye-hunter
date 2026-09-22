import {
    MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_WINDOW_SIZE,
    type DistributedArtifactEvidenceCursor
} from '../distributed-artifact-evidence-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { toBase64Url } from './compute-canonical-digest.ts';

/** The catalog a cursor belongs to: its artifact, its evidence model and the catalog instance that signed it. */
export interface EvidenceCursorIdentity {
    readonly artifactFingerprint: string;
    readonly modelFingerprint: string;
    readonly instanceId: string;
}

export interface EvidenceCursorPosition {
    readonly queryFingerprint: string;
    readonly windowSize: number;
    readonly offset: number;
}

export interface DecodedEvidenceCursor {
    readonly identity: EvidenceCursorIdentity;
    readonly position: EvidenceCursorPosition;
    /** The signed text: the base64url payload. */
    readonly body: string;
    readonly signature: ArrayBuffer;
}

/** The wire payload of a cursor; short keys keep the cursor small, and it names no evidence text. */
interface CursorPayload {
    readonly v: 1;
    readonly r: typeof CURSOR_REVISION;
    readonly a: string;
    readonly m: string;
    readonly i: string;
    readonly q: string;
    readonly s: number;
    readonly p: number;
}

const CURSOR_REVISION = 'distributed-artifact-evidence/source-v1';
const CURSOR_SIGNATURE_BYTES = 32;
const BASE64_URL_TEXT = /^[A-Za-z0-9_-]+$/;

let cursorMasterKey: Promise<CryptoKey> | undefined;

/** Each catalog signs with a key derived from its identity and a master key created once per page, on first use. */
export async function computeEvidenceCursorKey(identity: EvidenceCursorIdentity): Promise<CryptoKey> {
    cursorMasterKey ??= crypto.subtle.importKey(
        'raw',
        crypto.getRandomValues(new Uint8Array(32)),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const material = new Uint8Array(
        await crypto.subtle.sign(
            'HMAC',
            await cursorMasterKey,
            new TextEncoder().encode(
                JSON.stringify([identity.artifactFingerprint, identity.modelFingerprint, identity.instanceId])
            )
        )
    );
    return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createEvidenceCursor(
    identity: EvidenceCursorIdentity,
    key: CryptoKey,
    position: EvidenceCursorPosition
): Promise<DistributedArtifactEvidenceCursor> {
    const payload: CursorPayload = {
        v: 1,
        r: CURSOR_REVISION,
        a: identity.artifactFingerprint,
        m: identity.modelFingerprint,
        i: identity.instanceId,
        q: position.queryFingerprint,
        s: position.windowSize,
        p: position.offset
    };
    const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
    return `${body}.${toBase64Url(signature)}` as DistributedArtifactEvidenceCursor;
}

/** Undefined when the cursor is not a base64url payload of this revision and a signature of the expected length. */
export function decodeEvidenceCursor(cursor: string): DecodedEvidenceCursor | undefined {
    const parts = cursor.split('.');
    const [body, signatureText] = parts;
    if (parts.length !== 2 || !body || !signatureText) {
        return undefined;
    }
    const payload = decodeCursorPayload(body);
    const signature = decodeBase64Url(signatureText);
    if (payload === undefined || signature?.length !== CURSOR_SIGNATURE_BYTES) {
        return undefined;
    }
    return {
        identity: { artifactFingerprint: payload.a, modelFingerprint: payload.m, instanceId: payload.i },
        position: { queryFingerprint: payload.q, windowSize: payload.s, offset: payload.p },
        body,
        signature: signature.slice().buffer
    };
}

function decodeCursorPayload(body: string): CursorPayload | undefined {
    const bytes = decodeBase64Url(body);
    if (bytes === undefined) {
        return undefined;
    }
    try {
        const payload = JSON.parse(new TextDecoder().decode(bytes));
        return isCursorPayload(payload) ? payload : undefined;
    }
    catch {
        return undefined;
    }
}

function isCursorPayload(value: unknown): value is CursorPayload {
    return isJsonRecordValue(value) &&
        value.v === 1 &&
        value.r === CURSOR_REVISION &&
        typeof value.a === 'string' && typeof value.m === 'string' &&
        typeof value.i === 'string' && typeof value.q === 'string' &&
        Number.isSafeInteger(value.s) && Number(value.s) >= 1 &&
        Number(value.s) <= MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_WINDOW_SIZE &&
        Number.isSafeInteger(value.p);
}

function decodeBase64Url(value: string): Uint8Array | undefined {
    if (!BASE64_URL_TEXT.test(value)) {
        return undefined;
    }
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    try {
        const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
        return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    }
    catch {
        return undefined;
    }
}
