import { computeCourtAlertSignals } from './room-event-court-alert.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeRoomEvent } from '@shared/api/room-events/decode-room-event.ts';
import type { RoomEvent } from '@shared/api/room-events/room-event.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateRepositoryLike } from '../../runtime-state/runtime-state-repository.ts';
import { groupStateGroupStorageKey } from '../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';
import { computeViewInvalidationPublication } from '../websocket/outbox/compute-view-invalidation-publication.ts';
import { computeGuardedViewPublication } from '../websocket/outbox/guarded-view-publication.ts';
import { computeRoomEventWake } from './room-event-deadline.ts';

const ROOM_EVENTS_NAMESPACE = 'room-events:lobby';

export class RoomEventRepository {
    private readonly runtime: Pick<RuntimeStateRepositoryLike, 'findEntry'>;

    constructor(runtime: Pick<RuntimeStateRepositoryLike, 'findEntry'>) {
        this.runtime = runtime;
    }

    async read(lobby: GroupRef): Promise<RuntimeStateEntryValue<RoomEvent> | null> {
        const key = groupStateGroupStorageKey(lobby);
        const entry = await this.runtime.findEntry(ROOM_EVENTS_NAMESPACE, key);
        if (!entry) return null;
        const value = decodeRoomEvent(JSON.parse(entry.value));
        if (entry.key !== key || !isSameGroupRef(value.lobby, lobby)) {
            throw new TypeError('Stored room event belongs to another lobby.');
        }
        return { entry, value };
    }

    prepare(before: RuntimeStateEntryValue<RoomEvent> | null, after: RoomEvent,
        fences: readonly RuntimeStateGuardedBatchEffect[], facts: {
            readonly serviceId: string; readonly traceId: string; readonly createdAtEpochMs: number;
            readonly retentionMs: number; readonly audience: readonly string[];
        }) {
        const { applicationId, workspaceId, groupId } = after.lobby;
        const notice = computeViewInvalidationPublication({
            ...facts, resource: 'room-event', scope: { applicationId, workspaceId }, groupId, principalIds: facts.audience,
            changeId: computeSha256CanonicalJson({ lobby: after.lobby, revision: after.revision })
        });
        const row = { namespace: ROOM_EVENTS_NAMESPACE, key: groupStateGroupStorageKey(after.lobby), value: JSON.stringify(after),
            expireAtTimestamp: after.closed ? facts.createdAtEpochMs + facts.retentionMs : NEVER_EXPIRE_AT_TIMESTAMP };
        const guard = before ? { ...row, operation: 'update' as const, expectedRevision: before.entry.revision }
            : { ...row, operation: 'insert' as const };
        return computeGuardedViewPublication({ guard, effects: [...fences, ...notice.provenance] },
            [...notice.outbox, ...computeCourtAlertSignals(before?.value ?? null, after, facts), ...computeRoomEventWake(before?.value ?? null, after, facts)]);
    }
}
