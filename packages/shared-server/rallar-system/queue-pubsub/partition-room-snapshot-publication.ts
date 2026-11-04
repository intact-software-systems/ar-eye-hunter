import type { GroupScope } from '@shared/api/group-types.ts';
import {
    encodeLiveWsNotice,
    MAX_FRAGMENTED_LIVE_WS_NOTICE_BYTES,
    MAX_LIVE_WS_NOTICE_BYTES,
    type LiveWsAudience,
    type LiveWsPublicationInput
} from './live-ws-notice.ts';

type RoomSnapshotPublication =
    & LiveWsPublicationInput
    & Readonly<{
        audience: Extract<LiveWsAudience, { mode: 'generation-room'; }>;
        scope: GroupScope;
    }>;

interface Batch {
    readonly ids: string[];
    readonly generations: Map<string, string>;
    bytes: number;
}

/** One logical application frame, disjoint recipient partitions. Keep ordinary NOTIFY inline whenever one recipient fits. */
export function* partitionRoomSnapshotPublication(input: LiveWsPublicationInput): Generator<RoomSnapshotPublication> {
    if (input.audience.mode !== 'generation-room' || !input.scope) {
        throw new TypeError('Expected a scoped room snapshot');
    }
    const { recipientSessionIds, generations } = input.audience;
    if (
        new Set(recipientSessionIds).size !== recipientSessionIds.length ||
        Object.keys(generations).length !== recipientSessionIds.length
    ) {
        throw new TypeError('Room snapshot audience differs from its frozen generations');
    }
    const empty: RoomSnapshotPublication = {
        ...input,
        scope: input.scope,
        audience: { ...input.audience, recipientSessionIds: [], generations: {} }
    };
    const encoded = encodeLiveWsNotice(empty);
    if (encoded.kind === 'oversize') {
        throw new RangeError('An empty room snapshot envelope exceeds the private publication limit');
    }
    const baseBytes = new TextEncoder().encode(encoded.serialized).length;
    let batch: Batch = { ids: [], generations: new Map(), bytes: baseBytes };
    let cap = MAX_LIVE_WS_NOTICE_BYTES - 1;
    for (const id of recipientSessionIds) {
        if (!Object.hasOwn(generations, id) || !generations[id]) {
            throw new TypeError('A room snapshot recipient has no generation');
        }
        const rowBytes = stringBytes(id) * 2 + stringBytes(generations[id]) + 1;
        if (batch.ids.length > 0 && batch.bytes + rowBytes + 2 > cap) {
            yield toPartition(empty, batch);
            batch = { ids: [], generations: new Map(), bytes: baseBytes };
        }
        if (batch.ids.length === 0) {
            cap = baseBytes + rowBytes < MAX_LIVE_WS_NOTICE_BYTES
                ? MAX_LIVE_WS_NOTICE_BYTES - 1
                : MAX_FRAGMENTED_LIVE_WS_NOTICE_BYTES;
        }
        batch.bytes += rowBytes + (batch.ids.length === 0 ? 0 : 2);
        if (batch.bytes > cap) {
            throw new RangeError('A single room snapshot recipient exceeds the private publication limit');
        }
        batch.ids.push(id);
        batch.generations.set(id, generations[id]);
    }
    yield toPartition(empty, batch);
}

function stringBytes(value: string): number {
    return new TextEncoder().encode(JSON.stringify(value)).length;
}

function toPartition(empty: RoomSnapshotPublication, batch: Batch): RoomSnapshotPublication {
    return {
        ...empty,
        audience: {
            ...empty.audience,
            recipientSessionIds: batch.ids,
            generations: Object.fromEntries(batch.generations)
        }
    };
}
