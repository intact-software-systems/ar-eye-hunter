import type {
    ComputedClientStateSync,
    ComputedGroupStateSync
} from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type {
    AuditStamp,
    Group,
    GroupEvent,
    GroupSnapshot,
    GroupStateCausalRevision
} from '@shared/api/group-types.ts';

import { createTestGroup } from '../../../create-test-group.ts';

/** When the sync is computed and the trace of the request that caused it. */
export interface StateSyncEffectFixtureInput {
    readonly nowMs: number;
    readonly traceId: string;
}

/** The room's two live sessions, the audience a group delta is frozen to. */
export const STATE_SYNC_FIXTURE_SESSION_IDS: readonly string[] = ['a', 'b'];

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };
const ROOM = { ...SCOPE, groupId: 'room-1' };
const CAUSAL_REVISION: GroupStateCausalRevision = { groupRevision: 2, presenceRevision: 1 };
/** Long enough that a receipt budget (four 2 s windows) ends first. */
const STATE_SYNC_LIFETIME_MS = 60_000;
const AUDIT: AuditStamp = { atEpochMs: 1, actor: { kind: 'service', serviceId: 'test' }, reason: null, traceId: null, requestId: null };

export function createGroupDeltaStateSync(input: StateSyncEffectFixtureInput): ComputedGroupStateSync {
    return {
        ...toGroupStateSyncFacts(input),
        effects: [{ effectKind: 'member-state', payloadKind: 'delta-envelope', payload: createDeltaEnvelope() }]
    };
}

export function createGroupSnapshotStateSync(input: StateSyncEffectFixtureInput): ComputedGroupStateSync {
    return {
        ...toGroupStateSyncFacts(input),
        effects: [{ effectKind: 'member-state', payloadKind: 'snapshot', payload: createGroupSnapshot() }]
    };
}

export function createClientEventStateSync(input: StateSyncEffectFixtureInput): ComputedClientStateSync {
    return {
        commandId: 'client-event-command',
        aggregateRef: { ...SCOPE, principalId: 'alice' },
        acceptedCausalRevision: 5,
        audience: { kind: 'principal', ...SCOPE, resourceId: 'alice' },
        createdAtEpochMs: input.nowMs,
        expireAtEpochMs: input.nowMs + STATE_SYNC_LIFETIME_MS,
        effects: [{ effectKind: 'principal-state', payloadKind: 'event', payload: createClientEvent(input.nowMs) }],
        traceId: input.traceId
    };
}

function toGroupStateSyncFacts(input: StateSyncEffectFixtureInput): Omit<ComputedGroupStateSync, 'effects'> {
    return {
        commandId: 'delta-command',
        aggregateRef: ROOM,
        acceptedCausalRevision: CAUSAL_REVISION,
        audience: { kind: 'group', ...SCOPE, resourceId: ROOM.groupId },
        createdAtEpochMs: input.nowMs,
        expireAtEpochMs: input.nowMs + STATE_SYNC_LIFETIME_MS,
        traceId: input.traceId
    };
}

function createDeltaEnvelope(): GroupStateDeltaEnvelope {
    return {
        event: createGroupEvent(),
        predecessorCausalRevision: CAUSAL_REVISION,
        resultingCausalRevision: CAUSAL_REVISION,
        members: [],
        removedMemberPrincipalIds: [],
        sessions: [],
        removedSessionIds: [],
        activeSessionIds: STATE_SYNC_FIXTURE_SESSION_IDS,
        group: createRoom(),
        memberCount: 1,
        onlineMemberCount: 1,
        audienceSessionIds: STATE_SYNC_FIXTURE_SESSION_IDS
    };
}

function createGroupSnapshot(): GroupSnapshot {
    return {
        causalRevision: CAUSAL_REVISION,
        group: createRoom(),
        members: [{
            ...ROOM,
            principalId: 'alice',
            role: 'owner',
            status: 'active',
            joined: AUDIT,
            updated: AUDIT,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null
        }],
        activeSessions: [],
        memberCount: 1,
        onlineMemberCount: 0
    };
}

function createRoom(): Group {
    return createTestGroup({
        ...ROOM,
        snapshotVersion: CAUSAL_REVISION.groupRevision,
        presenceVersion: CAUSAL_REVISION.presenceRevision
    });
}

function createGroupEvent(): GroupEvent {
    return {
        ...ROOM,
        eventId: 'event-1',
        eventType: 'group-updated',
        snapshotVersion: CAUSAL_REVISION.groupRevision,
        causalRevision: CAUSAL_REVISION,
        occurredAtEpochMs: 1,
        actor: AUDIT.actor,
        reason: null,
        traceId: null,
        requestId: null,
        payload: {}
    };
}

function createClientEvent(nowMs: number): ClientEvent {
    return {
        ...SCOPE,
        principalId: 'alice',
        eventId: 'client-event-1',
        eventType: 'session-connected',
        snapshotVersion: 5,
        clientInstanceId: 'alice-instance',
        sessionId: 'a',
        occurredAtEpochMs: nowMs,
        actor: AUDIT.actor,
        reason: null,
        traceId: null,
        requestId: 'client-event-command',
        payload: {}
    };
}
