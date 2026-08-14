import { describe, expect, it, vi } from 'vitest';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import { validateGroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { AuditStamp, GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { resolveStateSyncRecipients } from '@shared-server/rallar-system/state-sync-routing.ts';

const NOW = Date.now();

describe('group-state delta envelope audience routing', () => {
  it('resolves recipients from the persisted audience without any cache lookup', () => {
    const server = createWebSocketServer(['alice-session', 'bob-session', 'other-session']);
    const findGroupSnapshotByRef = vi.fn(() => createGroupSnapshot());
    const readClientSnapshots = vi.fn(() => [] as readonly ClientSnapshot[]);
    const envelope = createEnvelope(['alice-session', 'bob-session']);
    expect(() => validateGroupStateDeltaEnvelope(envelope)).not.toThrow();

    const recipients = resolveStateSyncRecipients(server, createEnvelopeMessage(envelope), {
      findGroupSnapshotByRef,
      readClientSnapshots,
      now: () => NOW,
    });

    expect(connectionIds(recipients)).toEqual(['alice-session', 'bob-session']);
    expect(findGroupSnapshotByRef).not.toHaveBeenCalled();
    expect(readClientSnapshots).not.toHaveBeenCalled();
  });

  it('drops audience sessions without a locally open connection silently', () => {
    const server = createWebSocketServer(['alice-session']);
    const envelope = createEnvelope(['alice-session', 'ghost-session', 'bob-session']);

    const recipients = resolveStateSyncRecipients(server, createEnvelopeMessage(envelope), {
      now: () => NOW,
    });

    expect(connectionIds(recipients)).toEqual(['alice-session']);
  });

  it('still resolves a bare legacy event row through the snapshot cache path', () => {
    const server = createWebSocketServer(['alice-session', 'bob-session']);
    const snapshot = createGroupSnapshot();
    const findGroupSnapshotByRef = vi.fn(() => snapshot);
    const message = newALBroadcastMessage(
      'server-1',
      newALEventRoute(AppTopics.groupStateEvent, 'room-1', 'event-1'),
      'all',
      AppTopics.groupStateEvent,
      createGroupEvent(),
    );

    const recipients = resolveStateSyncRecipients(server, message, {
      findGroupSnapshotByRef,
      readClientSnapshots: () => [createClientSnapshot('alice', 'alice-session')],
      now: () => NOW,
    });

    expect(findGroupSnapshotByRef).toHaveBeenCalled();
    expect(connectionIds(recipients)).toEqual(['alice-session']);
  });

  it('treats a malformed envelope payload as invalid and resolves nobody', () => {
    const server = createWebSocketServer(['alice-session']);
    const envelope = createEnvelope(['alice-session']);
    const malformed = { ...envelope, onlineMemberCount: envelope.onlineMemberCount + 1 };

    const recipients = resolveStateSyncRecipients(server, createEnvelopeMessage(malformed), {
      now: () => NOW,
    });

    expect(recipients).toEqual([]);
  });
});

function connectionIds(
  recipients: ReturnType<typeof resolveStateSyncRecipients>,
): readonly string[] {
  return (recipients ?? []).map((recipient) => recipient.connectionId).sort();
}

function createWebSocketServer(sessionIds: readonly string[]): JsonWebSocketServer {
  return {
    connections: new Map(
      sessionIds.map((sessionId) => [sessionId, { id: sessionId, isOpen: true }]),
    ),
  } as unknown as JsonWebSocketServer;
}

function createEnvelopeMessage(envelope: GroupStateDeltaEnvelope) {
  return newALBroadcastMessage(
    'server-1',
    newALEventRoute(AppTopics.groupStateEvent, 'room-1', envelope.event.eventId),
    'all',
    AppTopics.groupStateEvent,
    envelope,
  );
}

function createEnvelope(audienceSessionIds: readonly string[]): GroupStateDeltaEnvelope {
  const snapshot = createGroupSnapshot();
  return {
    event: createGroupEvent(),
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
    audienceSessionIds,
  };
}

function createGroupSnapshot(): GroupSnapshot {
  const audit = createAuditStamp();
  return {
    stateRevision: 2_000_002,
    causalRevision: { groupRevision: 2, presenceRevision: 2 },
    group: {
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      groupId: 'room-1',
      slug: null,
      displayName: 'room-1',
      description: null,
      kind: 'room',
      status: 'active',
      archived: null,
      deleted: null,
      joinMode: 'open',
      maxMembers: null,
      maxSessionsPerMember: null,
      metadata: {},
      activeMemberCount: 2,
      ownerPrincipalId: 'alice',
      snapshotVersion: 2,
      metadataVersion: 1,
      rosterVersion: 1,
      presenceVersion: 2,
      created: audit,
      updated: audit,
      expiresAtEpochMs: null,
      emptySinceEpochMs: null,
      purgeAfterEpochMs: null,
    },
    members: [toActiveMember('alice', 'owner'), toActiveMember('bob', 'member')],
    activeSessions: [
      toActiveSession('alice', 'alice-session'),
      toActiveSession('bob', 'bob-session'),
    ],
    memberCount: 2,
    onlineMemberCount: 2,
  };
}

function toActiveMember(principalId: string, role: 'owner' | 'member') {
  return {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1',
    principalId,
    role,
    status: 'active',
    joined: createAuditStamp(),
    updated: createAuditStamp(),
    left: null,
    removed: null,
    banned: null,
    invitedByPrincipalId: null,
    invitationExpiresAtEpochMs: null,
  } as const;
}

function toActiveSession(principalId: string, sessionId: string) {
  return {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1',
    principalId,
    sessionId,
    generationId: `${sessionId}-generation`,
    generationVersion: 1,
    status: 'active',
    disconnectedAtEpochMs: null,
    disconnectReason: null,
    connectedAtEpochMs: 1,
    lastHeartbeatAtEpochMs: NOW,
    expiresAtEpochMs: NOW + 60_000,
  } as const;
}

function createGroupEvent(): GroupEvent {
  return {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1',
    eventId: 'event-1',
    eventType: 'session-connected',
    snapshotVersion: 2,
    causalRevision: { groupRevision: 2, presenceRevision: 2 },
    occurredAtEpochMs: NOW,
    actor: { kind: 'session', sessionId: 'bob-session', principalId: 'bob' },
    reason: null,
    traceId: null,
    requestId: null,
    payload: {},
  };
}

function createClientSnapshot(principalId: string, sessionId: string): ClientSnapshot {
  const audit = createAuditStamp();
  return {
    stateRevision: 1,
    principal: {
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      principalId,
      username: principalId,
      displayName: principalId,
      avatarUrl: null,
      authProvider: null,
      externalSubjectId: null,
      status: 'active',
      disabled: null,
      deleted: null,
      roles: [],
      metadata: {},
      profileVersion: 1,
      presenceVersion: 1,
      snapshotVersion: 1,
      created: audit,
      updated: audit,
      lastSeenAtEpochMs: NOW,
    },
    instances: [],
    activeSessions: [
      {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId,
        clientInstanceId: 'browser',
        sessionId,
        generationId: `${sessionId}-generation`,
        generationVersion: 1,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null,
        presenceState: 'online',
        transport: 'ws',
        connectionId: sessionId,
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: NOW,
        expiresAtEpochMs: NOW + 60_000,
      },
    ],
    isOnline: true,
    activeSessionCount: 1,
    lastSeenAtEpochMs: NOW,
  };
}

function createAuditStamp(): AuditStamp {
  return {
    atEpochMs: 1,
    actor: { kind: 'service', serviceId: 'test' },
    reason: null,
    traceId: null,
    requestId: null,
  };
}
