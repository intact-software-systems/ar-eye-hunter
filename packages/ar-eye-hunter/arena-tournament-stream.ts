import type { ALMessage, ALRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { requireEpoch, requireExactKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { assertValidRallarRouteId, RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES } from '@shared/api/rallar-validation.ts';
import type { TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';
import { isServerRoomSnapshotMessage } from '@shared/api/views/server-room-snapshot.ts';
import { decodeBase64Url, toBase64Url } from '@shared/encoding/base64url.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { decodeArenaTournamentSnapshot, type ArenaTournamentSnapshot } from './arena-tournament-snapshot.ts';

export const ARENA_TOURNAMENT_SNAPSHOT_TOPIC = AppTopics.serverRoomSnapshot;
export const ARENA_TOURNAMENT_SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };
export const ARENA_TOURNAMENT_SNAPSHOT_SENDER = 'ar-eye-tournament-server';
const MAX_SNAPSHOT_BYTES = 65_536;
// Includes the gzip header/trailer and the deflate overhead of an incompressible maximum-size frame.
const MAX_COMPRESSED_BYTES = MAX_SNAPSHOT_BYTES + 128;

export interface ArenaTournamentFrame {
    readonly version: 1;
    readonly encoding: 'gzip-base64url';
    readonly attemptId: string;
    readonly attemptRevision: number;
    readonly uncompressedBytes: number;
    readonly data: string;
}

export function arenaTournamentFrameRoute(binding: TournamentMatchBinding): ALRoute {
    return toAppQueueKey({
        topicId: ARENA_TOURNAMENT_SNAPSHOT_TOPIC,
        contextId: binding.roomRef.groupId,
        resourceId: binding.gameId
    });
}

export function isArenaTournamentRoomFrame(message: ALMessage, room: GroupRef): boolean {
    return room.applicationId === ARENA_TOURNAMENT_SCOPE.applicationId &&
        room.workspaceId === ARENA_TOURNAMENT_SCOPE.workspaceId &&
        isServerRoomSnapshotMessage(message, { producerId: ARENA_TOURNAMENT_SNAPSHOT_SENDER, scope: room }) &&
        message.targets?.mode === 'broadcast' && message.targets.groupRef !== undefined &&
        isSameGroupRef(message.targets.groupRef, room);
}

export function isArenaTournamentFrameMessage(message: ALMessage, binding: TournamentMatchBinding): boolean {
    return isArenaTournamentRoomFrame(message, binding.roomRef) &&
        message.route.resourceId === arenaTournamentFrameRoute(binding).resourceId;
}

/** Called once for the selected committed value, after publisher coalescing. */
export async function encodeArenaTournamentFrame(snapshot: ArenaTournamentSnapshot): Promise<ArenaTournamentFrame> {
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
    if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
        throw new RangeError('Arena tournament snapshot exceeds the frame byte limit');
    }
    const gzip = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    const zipped = new Uint8Array(await new Response(gzip).arrayBuffer());
    if (zipped.length > MAX_COMPRESSED_BYTES) {
        throw new RangeError('Compressed arena tournament snapshot exceeds the frame byte limit');
    }
    const frame: ArenaTournamentFrame = {
        version: 1,
        encoding: 'gzip-base64url',
        attemptId: snapshot.binding.attemptId,
        attemptRevision: snapshot.attemptRevision,
        uncompressedBytes: bytes.length,
        data: toBase64Url(zipped)
    };
    assertFramePayloadSize(frame);
    return frame;
}

export function decodeArenaTournamentFrameHeader(value: unknown): ArenaTournamentFrame {
    const frame = requireRecord(value, 'Arena tournament frame');
    requireExactKeys(
        frame,
        ['version', 'encoding', 'attemptId', 'attemptRevision', 'uncompressedBytes', 'data'],
        'Arena tournament frame'
    );
    requireString(frame.attemptId, 'Arena tournament frame attempt');
    const attemptId = assertValidRallarRouteId(frame.attemptId);
    requireEpoch(frame.attemptRevision, 'Arena tournament frame revision');
    requireEpoch(frame.uncompressedBytes, 'Uncompressed arena tournament bytes');
    requireString(frame.data, 'Compressed arena tournament state');
    if (
        frame.version !== 1 || frame.encoding !== 'gzip-base64url' || frame.uncompressedBytes === 0 ||
        frame.uncompressedBytes > MAX_SNAPSHOT_BYTES || frame.data.length > Math.ceil(MAX_COMPRESSED_BYTES * 4 / 3)
    ) {
        throw new TypeError('Arena tournament frame version, encoding or size is invalid');
    }
    const decoded: ArenaTournamentFrame = {
        version: 1,
        encoding: 'gzip-base64url',
        attemptId,
        attemptRevision: frame.attemptRevision,
        uncompressedBytes: frame.uncompressedBytes,
        data: frame.data
    };
    assertFramePayloadSize(decoded);
    return decoded;
}

function assertFramePayloadSize(frame: ArenaTournamentFrame): void {
    if (new TextEncoder().encode(JSON.stringify(frame)).byteLength > RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES) {
        throw new RangeError('Arena tournament frame exceeds the application message byte limit');
    }
}

export async function decodeArenaTournamentFrame(value: unknown): Promise<ArenaTournamentSnapshot> {
    const frame = decodeArenaTournamentFrameHeader(value);
    const zipped = decodeBase64Url(frame.data).right;
    if (!zipped) {
        throw new TypeError('Arena tournament frame is not unpadded base64url');
    }
    const bytes = await decompressFrame(zipped, frame.uncompressedBytes);
    const snapshot = decodeArenaTournamentSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (snapshot.attemptRevision !== frame.attemptRevision || snapshot.binding.attemptId !== frame.attemptId) {
        throw new TypeError('Arena tournament frame stamp differs from its snapshot');
    }
    return snapshot;
}

async function decompressFrame(compressed: Uint8Array, size: number): Promise<Uint8Array> {
    const output = new Uint8Array(size);
    const reader = new Blob([Uint8Array.from(compressed)]).stream().pipeThrough(new DecompressionStream('gzip'))
        .getReader();
    let offset = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) {
                break;
            }
            if (offset + next.value.length > size) {
                await reader.cancel();
                throw new RangeError('Arena tournament frame expanded beyond its declared byte count');
            }
            output.set(next.value, offset);
            offset += next.value.length;
        }
    }
    finally {
        reader.releaseLock();
    }
    if (offset !== size) {
        throw new RangeError('Arena tournament frame did not expand to its declared byte count');
    }
    return output;
}
