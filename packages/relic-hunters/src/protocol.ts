import type { GroupRef } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';

export const RELIC_PROTOCOL_VERSION = 1 as const;

export const RELIC_TOPICS = {
    command: 'room.relic.command',
    snapshot: 'room.relic.snapshot',
    event: 'room.relic.event',
    aiPlanning: 'room.relic.ai.planning',
    hunter: 'room.relic.hunter'
} as const;

export const RELIC_TYPES = {
    command: 'relic.command.v1',
    snapshot: 'relic.snapshot.v1',
    event: 'relic.event.v1',
    aiPlanningProposal: 'relic.ai.planning-proposal.v1',
    hunter: 'relic.hunter.v1'
} as const;

export function toRelicRoomGroupRef(roomId: string): GroupRef {
    return {
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
        groupId: roomId
    };
}
