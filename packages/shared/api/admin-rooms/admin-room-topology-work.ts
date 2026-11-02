import type { GroupRef } from '../group-types.ts';

export const ADMIN_ROOM_TOPOLOGY_WORK_STATUSES = ['unknown', 'pending', 'completed', 'failed'] as const;

export interface AdminRoomTopologyWorkRequest {
    readonly roomRef: GroupRef;
    readonly outboxId: string;
}

/** Work completion does not prove client delivery, formation or gameplay recovery. */
export interface AdminRoomTopologyWorkResponse extends AdminRoomTopologyWorkRequest {
    readonly observedAtEpochMs: number;
    readonly status: (typeof ADMIN_ROOM_TOPOLOGY_WORK_STATUSES)[number];
    readonly attempts: number | null;
    readonly settledAtEpochMs: number | null;
}
