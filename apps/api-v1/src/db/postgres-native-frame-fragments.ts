import { computeSha256CanonicalJson } from '@shared-server/rallar-system/protocol/compute-sha256-canonical-json.ts';
import { decodeJsonWireValue, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { isNoticeWireRecord } from '@shared-server/rallar-system/queue-pubsub/is-notice-wire-record.ts';
import {
    MAX_FRAGMENTED_LIVE_WS_NOTICE_BYTES,
    MAX_LIVE_WS_NOTICE_BYTES
} from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import { AL_PUBLICATION_STAGE_LIMITS } from '@shared/al-contracts/publication/al-publication-stage-limits.ts';
import { requireEpoch, requireExactKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import { decodeBase64Url, toBase64Url } from '@shared/encoding/base64url.ts';
import { createDefaultBackgroundTimers } from '@shared/resilience/timers.ts';

const PART_BYTES = 5_500; // 7,334 base64 characters leave room for the closed header below PostgreSQL's 8,000-byte cap.
const FRAGMENT_KIND = 'server-room-fragment';

interface NativeFramePart {
    readonly kind: typeof FRAGMENT_KIND;
    readonly hash: string;
    readonly index: number;
    readonly totalBytes: number;
    readonly expiresAtMs: number;
    readonly data: string;
}

interface PartialFrame {
    readonly bytes: Uint8Array;
    readonly indexes: Set<number>;
    readonly expiresAtMs: number;
    readonly cancel: () => void;
}

export function fragmentPostgresNativeFrame(text: string, expiresAtMs: number): readonly NativeFramePart[] {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length < MAX_LIVE_WS_NOTICE_BYTES || bytes.length > MAX_FRAGMENTED_LIVE_WS_NOTICE_BYTES) {
        throw new RangeError('Invalid PostgreSQL native notice size');
    }
    const hash = computeSha256CanonicalJson(text);
    return Array.from({ length: Math.ceil(bytes.length / PART_BYTES) }, (_, index) => ({
        kind: FRAGMENT_KIND,
        hash,
        index,
        totalBytes: bytes.length,
        expiresAtMs,
        data: toBase64Url(bytes.subarray(index * PART_BYTES, (index + 1) * PART_BYTES))
    }));
}

/** Ephemeral state owned by one LISTEN subscription. No partial frame leaves the transport. */
export class PostgresNativeFrameFragments {
    private readonly pending = new Map<string, PartialFrame>();
    private readonly timers = createDefaultBackgroundTimers();
    private allocated = 0;
    private readonly completed = new Map<string, number>();
    private readonly onGap: () => void;

    constructor(onGap: () => void) {
        this.onGap = onGap;
    }

    clear(): void {
        for (const hash of this.pending.keys()) {
            this.release(hash);
        }
        this.completed.clear();
    }

    read(value: JsonWireValue, nowMs: number): JsonWireValue | undefined {
        if (!isNoticeWireRecord(value) || value.kind !== FRAGMENT_KIND) {
            return value;
        }
        const part = decodeNativeFramePart(value, nowMs);
        if (!part || this.completed.has(part.hash)) {
            return undefined;
        }
        const decoded = decodeBase64Url(part.data).right;
        if (!decoded || decoded.length !== Math.min(PART_BYTES, part.totalBytes - part.index * PART_BYTES)) {
            return undefined;
        }
        const partial = this.pending.get(part.hash) ?? this.start(part, nowMs);
        if (!partial) {
            return undefined;
        }
        if (partial.bytes.length !== part.totalBytes || partial.expiresAtMs !== part.expiresAtMs) {
            return this.drop(part.hash);
        }
        const offset = part.index * PART_BYTES;
        if (partial.indexes.has(part.index)) {
            if (!decoded.every((byte, i) => partial.bytes[offset + i] === byte)) {
                this.drop(part.hash);
            }
            return undefined;
        }
        partial.bytes.set(decoded, offset);
        partial.indexes.add(part.index);
        if (partial.indexes.size !== Math.ceil(part.totalBytes / PART_BYTES)) {
            return undefined;
        }
        this.release(part.hash);
        try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(partial.bytes);
            if (computeSha256CanonicalJson(text) !== part.hash) {
                throw new TypeError('Native notice digest differs');
            }
            const restored = decodeJsonWireValue(JSON.parse(text), 'Reassembled server room notice');
            if (
                !isNoticeWireRecord(restored) || restored.delivery !== 'inline' ||
                restored.expiresAtMs !== part.expiresAtMs ||
                !isNoticeWireRecord(restored.audience) || restored.audience.mode !== 'generation-room'
            ) {
                throw new TypeError('Fragmented notice is not the authorized room publication');
            }
            this.remember(part.hash, part.expiresAtMs, nowMs);
            return restored;
        }
        catch {
            this.onGap();
            return undefined;
        }
    }

    private remember(hash: string, expiry: number, nowMs: number): void {
        // A late duplicate must not start a partial transfer and report a false delivery gap.
        for (const [id, until] of this.completed) {
            if (until <= nowMs) {
                this.completed.delete(id);
            }
        }
        if (this.completed.size >= AL_PUBLICATION_STAGE_LIMITS.maxStagedValues) {
            const oldest = this.completed.keys().next().value;
            if (oldest !== undefined) {
                this.completed.delete(oldest);
            }
        }
        this.completed.set(hash, expiry);
    }

    private start(part: NativeFramePart, nowMs: number): PartialFrame | undefined {
        if (
            this.pending.size >= AL_PUBLICATION_STAGE_LIMITS.maxStreams ||
            this.allocated + part.totalBytes > AL_PUBLICATION_STAGE_LIMITS.maxStagedBytes
        ) {
            this.onGap();
            return undefined;
        }
        const partial: PartialFrame = {
            bytes: new Uint8Array(part.totalBytes),
            indexes: new Set(),
            expiresAtMs: part.expiresAtMs,
            cancel: this.timers.schedule(() => {
                this.drop(part.hash);
            }, Math.min(5000, part.expiresAtMs - nowMs))
        };
        this.pending.set(part.hash, partial);
        this.allocated += part.totalBytes;
        return partial;
    }

    private drop(hash: string): undefined {
        this.release(hash);
        this.onGap();
        return undefined;
    }

    private release(hash: string): void {
        const prior = this.pending.get(hash);
        if (!prior) {
            return;
        }
        prior.cancel();
        this.pending.delete(hash);
        this.allocated -= prior.bytes.length;
    }
}

function decodeNativeFramePart(value: JsonWireValue, nowMs: number): NativeFramePart | undefined {
    try {
        const part = requireRecord(value, 'Native frame part');
        requireExactKeys(part, ['kind', 'hash', 'index', 'totalBytes', 'expiresAtMs', 'data'], 'Native frame part');
        requireEpoch(part.index, 'Native frame part index');
        requireEpoch(part.totalBytes, 'Native frame total bytes');
        requireEpoch(part.expiresAtMs, 'Native frame expiry');
        requireString(part.hash, 'Native frame digest');
        requireString(part.data, 'Native frame part data');
        if (
            part.kind !== FRAGMENT_KIND || !/^[a-f0-9]{64}$/u.test(part.hash) || part.expiresAtMs <= nowMs ||
            part.totalBytes < MAX_LIVE_WS_NOTICE_BYTES || part.totalBytes > MAX_FRAGMENTED_LIVE_WS_NOTICE_BYTES ||
            part.index >= Math.ceil(part.totalBytes / PART_BYTES) || part.data.length > Math.ceil(PART_BYTES * 4 / 3)
        ) {
            return undefined;
        }
        return {
            kind: FRAGMENT_KIND,
            hash: part.hash,
            index: part.index,
            totalBytes: part.totalBytes,
            expiresAtMs: part.expiresAtMs,
            data: part.data
        };
    }
    catch {
        return undefined;
    }
}
