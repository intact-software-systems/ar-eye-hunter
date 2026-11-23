import type { RallarStateEventMessage } from '../messages/rallar-message-contracts.ts';

import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { assertValidRallarGroupRef, assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import type { CreateBrowserRallarRoomsInput } from '../rooms/browser-rallar-rooms.ts';
import { captureRoomSession } from '../rooms/room-session-fence.ts';
import { parseGroupStateDeltaEnvelope } from '../state-cache/group-state-delta-application.ts';
import { readStateGroupSnapshot } from './point-read.ts';

export interface ObservedRoomMetadata {
    readonly snapshotVersion: number;
    readonly purgeAfterEpochMs: number | null;
    readonly metadata: ApiJsonObject;
}

export function explicitRoomRef(room: GroupRef): GroupRef {
    assertValidRallarGroupRef(room, '$.roomRef');
    assertValidRallarRouteId(room.workspaceId, '$.roomRef.workspaceId', 'Workspace ID');
    return { ...room };
}

export async function readObservedRoom(
    roomRef: GroupRef,
    requireSession: CreateBrowserRallarRoomsInput['requireSession'],
    signal?: AbortSignal
): Promise<ObservedRoomMetadata> {
    const room = explicitRoomRef(roomRef);
    const fence = captureRoomSession(requireSession, signal);
    fence.assertCurrent();
    const result = await readStateGroupSnapshot(room.groupId, room, { authSession: fence.session, signal });
    fence.assertCurrent();
    if (result.source !== 'durable' || !isSameGroupRef(result.snapshot.group, room)) {
        throw new Error('Room reads require the requested durable snapshot.');
    }
    return result.snapshot.group;
}

export function readObservedRoomDelta(
    message: Pick<RallarStateEventMessage, 'transport' | 'topicId' | 'typeId' | 'raw'>,
    room: GroupRef
) {
    if (
        message.transport !== 'ws' || message.topicId !== AppTopics.groupStateEvent ||
        message.typeId !== AppTopics.groupStateEvent
    ) {
        return;
    }
    const target = readALTargetGroupRef(message.raw);
    if (!target || !isSameGroupRef(target, room)) {
        return;
    }
    return parseGroupStateDeltaEnvelope(message.raw.payload.resource, room)?.group;
}

export function validateReadRevision<T extends { readonly revision: number; }>(
    next: T | null,
    previous: T | null,
    announcedRevision: number,
    regresses: (previous: T, next: T) => boolean
): void {
    if ((next?.revision ?? 0) < announcedRevision) {
        throw new Error('Room read predates the server notification.');
    }
    if (previous && (!next || next.revision < previous.revision || regresses(previous, next))) {
        throw new Error('Room read regressed.');
    }
}
