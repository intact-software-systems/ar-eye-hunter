import type { GroupScope } from '@shared/api/group-types.ts';
import { computeUtf8ByteLength } from '@shared/encoding/compute-utf8-byte-length.ts';
import { Either } from '@shared/resilience/Either.ts';
import {
    encodeLiveWsNotice,
    MAX_FRAGMENTED_LIVE_WS_NOTICE_BYTES,
    MAX_LIVE_WS_NOTICE_BYTES,
    type GenerationRoomLiveWsAudience,
    type LiveWsPublicationBase,
    type LiveWsPublicationInput
} from './live-ws-notice.ts';

export interface RoomSnapshotPublication extends LiveWsPublicationBase {
    readonly audience: GenerationRoomLiveWsAudience;
    readonly scope: GroupScope;
}

interface RecipientBatch {
    readonly ids: string[];
    bytes: number;
}

export function isRoomSnapshotPublication(input: LiveWsPublicationInput): input is RoomSnapshotPublication {
    return input.audience.mode === 'generation-room' && input.scope !== undefined;
}

/**
 * One logical frame across disjoint recipient partitions, each kept inline whenever its recipients fit. Every partition
 * is computed before any is published, so a recipient that fits no notice refuses the whole publication.
 */
export function partitionRoomSnapshotPublication(
    publication: RoomSnapshotPublication
): Either<string, readonly RoomSnapshotPublication[]> {
    const { recipientSessionIds, generations } = publication.audience;
    if (
        new Set(recipientSessionIds).size !== recipientSessionIds.length ||
        Object.keys(generations).length !== recipientSessionIds.length ||
        !recipientSessionIds.every((id) => Object.hasOwn(generations, id) && generations[id].length > 0)
    ) {
        return Either.ofLeft('Room snapshot audience differs from its frozen generations');
    }
    const empty: RoomSnapshotPublication = {
        ...publication,
        audience: { ...publication.audience, recipientSessionIds: [], generations: {} }
    };
    const encoded = encodeLiveWsNotice(empty);
    if (encoded.kind === 'oversize') {
        return Either.ofLeft('An empty room snapshot envelope exceeds the private publication limit');
    }
    const batches = toRecipientBatches(computeUtf8ByteLength(encoded.serialized), publication.audience);
    return batches.left === undefined
        ? Either.ofRight(batches.right!.map((batch) => toPartition(empty, batch.ids, generations)))
        : Either.ofLeft(batches.left);
}

function toRecipientBatches(
    baseBytes: number,
    { recipientSessionIds, generations }: GenerationRoomLiveWsAudience
): Either<string, readonly RecipientBatch[]> {
    const batches: RecipientBatch[] = [{ ids: [], bytes: baseBytes }];
    let cap = MAX_LIVE_WS_NOTICE_BYTES - 1;
    for (const id of recipientSessionIds) {
        // The serialized notice grows by the quoted id in both the session list and the generation map, the quoted
        // generation and the map's colon; every recipient after a batch's first adds one comma to each of the two.
        const rowBytes = toJsonStringBytes(id) * 2 + toJsonStringBytes(generations[id]) + 1;
        let batch = batches[batches.length - 1];
        if (batch.ids.length > 0 && batch.bytes + rowBytes + 2 > cap) {
            batch = { ids: [], bytes: baseBytes };
            batches.push(batch);
        }
        if (batch.ids.length === 0) {
            cap = baseBytes + rowBytes < MAX_LIVE_WS_NOTICE_BYTES
                ? MAX_LIVE_WS_NOTICE_BYTES - 1
                : MAX_FRAGMENTED_LIVE_WS_NOTICE_BYTES;
        }
        batch.bytes += rowBytes + (batch.ids.length === 0 ? 0 : 2);
        if (batch.bytes > cap) {
            return Either.ofLeft('A single room snapshot recipient exceeds the private publication limit');
        }
        batch.ids.push(id);
    }
    return Either.ofRight(batches);
}

function toJsonStringBytes(value: string): number {
    return computeUtf8ByteLength(JSON.stringify(value));
}

function toPartition(
    empty: RoomSnapshotPublication,
    ids: readonly string[],
    generations: Readonly<Record<string, string>>
): RoomSnapshotPublication {
    return {
        ...empty,
        audience: {
            ...empty.audience,
            recipientSessionIds: ids,
            generations: Object.fromEntries(ids.map((id) => [id, generations[id]]))
        }
    };
}
