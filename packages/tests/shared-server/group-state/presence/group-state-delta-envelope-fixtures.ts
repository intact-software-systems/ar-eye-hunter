import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { AuditStamp, GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { WsServerResolvedRecipient } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { createTestGroup } from '../../../create-test-group.ts';
import { createOpenTestWebSocket } from '../../rallar-system/websocket/test-support/open-test-websocket.ts';

export const DELTA_ENVELOPE_FIXTURE_NOW = Date.now();

export const DELTA_ENVELOPE_FIXTURE_GROUP_REF = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
} as const;

export interface DeltaEnvelopeFixtureMember {
    readonly principalId: string;
    readonly sessionId: string;
    readonly role: 'owner' | 'member';
}

export const DELTA_ENVELOPE_FIXTURE_MEMBERS: readonly DeltaEnvelopeFixtureMember[] = [
    { principalId: 'alice', sessionId: 'alice-session', role: 'owner' },
    { principalId: 'bob', sessionId: 'bob-session', role: 'member' }
];

export function createDeltaEnvelopeFixtureWebSocketServer(
    sessionIds: readonly string[]
): JsonWebSocketServer {
    const server = new JsonWebSocketServer();
    for (const sessionId of sessionIds) {
        server.connections.set(
            sessionId,
            new ConnectionContext(sessionId, createOpenTestWebSocket())
        );
    }
    return server;
}

export function readFixtureConnectionIds(
    recipients: readonly WsServerResolvedRecipient[] | undefined
): readonly string[] {
    return (recipients ?? []).map((recipient) => recipient.connectionId);
}

export function createDeltaEnvelopeFixtureGroupSnapshot(
    members: readonly DeltaEnvelopeFixtureMember[] = DELTA_ENVELOPE_FIXTURE_MEMBERS,
    groupId: string = DELTA_ENVELOPE_FIXTURE_GROUP_REF.groupId
): GroupSnapshot {
    const audit = createDeltaEnvelopeFixtureAuditStamp();
    return {
        causalRevision: { groupRevision: 2, presenceRevision: 2 },
        group: createTestGroup({
            applicationId: DELTA_ENVELOPE_FIXTURE_GROUP_REF.applicationId,
            workspaceId: DELTA_ENVELOPE_FIXTURE_GROUP_REF.workspaceId,
            groupId,
            displayName: groupId,
            activeMemberCount: members.length,
            ownerPrincipalId: members[0]?.principalId ?? 'alice',
            snapshotVersion: 2,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 2,
            created: audit,
            updated: audit
        }),
        members: members.map((member) => toFixtureActiveMember(member, groupId)),
        activeSessions: members.map((member) => toFixtureActiveSession(member, groupId)),
        memberCount: members.length,
        onlineMemberCount: members.length
    };
}

export interface CreateDeltaEnvelopeFixtureInput {
    readonly audienceSessionIds: readonly string[];
    readonly members?: readonly DeltaEnvelopeFixtureMember[];
    readonly groupId?: string;
}

export function createDeltaEnvelopeFixture(
    input: CreateDeltaEnvelopeFixtureInput
): GroupStateDeltaEnvelope {
    const groupId = input.groupId ?? DELTA_ENVELOPE_FIXTURE_GROUP_REF.groupId;
    const snapshot = createDeltaEnvelopeFixtureGroupSnapshot(input.members, groupId);
    return {
        event: createDeltaEnvelopeFixtureGroupEvent(groupId),
        predecessorCausalRevision: { groupRevision: 2, presenceRevision: 1 },
        resultingCausalRevision: snapshot.causalRevision,
        members: [],
        removedMemberPrincipalIds: [],
        sessions: snapshot.activeSessions,
        removedSessionIds: [],
        activeSessionIds: snapshot.activeSessions.map((session) => session.sessionId),
        group: snapshot.group,
        memberCount: snapshot.memberCount,
        onlineMemberCount: snapshot.onlineMemberCount,
        audienceSessionIds: input.audienceSessionIds
    };
}

export function createDeltaEnvelopeFixtureGroupEvent(
    groupId: string = DELTA_ENVELOPE_FIXTURE_GROUP_REF.groupId
): GroupEvent {
    return {
        applicationId: DELTA_ENVELOPE_FIXTURE_GROUP_REF.applicationId,
        workspaceId: DELTA_ENVELOPE_FIXTURE_GROUP_REF.workspaceId,
        groupId,
        eventId: 'event-1',
        eventType: 'session-connected',
        snapshotVersion: 2,
        causalRevision: { groupRevision: 2, presenceRevision: 2 },
        occurredAtEpochMs: DELTA_ENVELOPE_FIXTURE_NOW,
        actor: { kind: 'session', sessionId: 'bob-session', principalId: 'bob' },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {}
    };
}

export function createDeltaEnvelopeFixtureAuditStamp(): AuditStamp {
    return {
        atEpochMs: DELTA_ENVELOPE_FIXTURE_NOW,
        actor: { kind: 'session', sessionId: 'alice-session', principalId: 'alice' },
        reason: null,
        traceId: null,
        requestId: null
    };
}

function toFixtureActiveMember(member: DeltaEnvelopeFixtureMember, groupId: string) {
    return {
        applicationId: DELTA_ENVELOPE_FIXTURE_GROUP_REF.applicationId,
        workspaceId: DELTA_ENVELOPE_FIXTURE_GROUP_REF.workspaceId,
        groupId,
        principalId: member.principalId,
        role: member.role,
        status: 'active',
        joined: createDeltaEnvelopeFixtureAuditStamp(),
        updated: createDeltaEnvelopeFixtureAuditStamp(),
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    } as const;
}

function toFixtureActiveSession(member: DeltaEnvelopeFixtureMember, groupId: string) {
    return {
        applicationId: DELTA_ENVELOPE_FIXTURE_GROUP_REF.applicationId,
        workspaceId: DELTA_ENVELOPE_FIXTURE_GROUP_REF.workspaceId,
        groupId,
        principalId: member.principalId,
        sessionId: member.sessionId,
        generationId: `${member.sessionId}-generation`,
        generationVersion: 1,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: DELTA_ENVELOPE_FIXTURE_NOW,
        expiresAtEpochMs: DELTA_ENVELOPE_FIXTURE_NOW + 60_000
    } as const;
}
