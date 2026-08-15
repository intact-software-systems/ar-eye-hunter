import { describe, expect, it } from 'vitest';

import type {
  AuditStamp,
  GroupMember,
  GroupPresenceSession,
  GroupSnapshot,
} from '@shared/api/group-types.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/repositories/RtcRttRepository.ts';
import { toRtcRttMutationReceiptId } from '@shared-server/rallar-system/rtc-topology/mutation/rtc-rtt-mutation-identifiers.ts';
import { AppOutboxType } from '@shared-server/rallar-system/services/AppOutboxService.ts';
import {
  parsePersistedRtcTopologyALMessage,
  readRtcTopologyWorkEnvelope,
} from '@shared-server/rallar-system/topology/replay/rtc-topology-work-codec.ts';

import {
  createAuthorityHarness,
  createResilience,
  SCOPE,
} from '../../group-state/inbox/group-state-inbox-test-runtime.ts';

describe('durable RTC RTT refinement work', () => {
  it('preserves the accepted RTT observation in final topology work', async () => {
    const harness = await createAuthorityHarness(['alice', 'bob']);
    const rtt = {
      sessionIdFrom: 'alice-session',
      sessionIdTo: 'bob-session',
      rttMs: 12,
      createdAtEpochMs: harness.nowEpochMs,
      version: 1,
    };
    const group = createRttGroupSnapshot(harness.nowEpochMs);
    harness.service.setRtcRttAppInboxDependencies({
      repository: new RtcRttRepository(harness.runtimeRepository, {
        now: () => harness.nowEpochMs,
      }),
      readPolicyInputs: async () => ({
        candidateGroups: [group],
        overlaySnapshotsByGroupKey: new Map(),
        degreeLimit: 2,
      }),
    });

    await harness.service.enqueueRtcRtt({
      rtt,
      alSenderId: rtt.sessionIdFrom,
      capturedAtEpochMs: harness.nowEpochMs,
    });
    await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

    expect(harness.database.outboxEntries.size).toBe(1);
    const entry = [...harness.database.outboxEntries.values()][0];
    if (!entry) throw new Error('Expected durable RTC topology work');
    const message = parsePersistedRtcTopologyALMessage(entry.resource);
    const envelope = readRtcTopologyWorkEnvelope(message, AppOutboxType.RTC_TOPOLOGY_RECOMPUTE);
    expect(envelope.data).toMatchObject({
      kind: 'rtt-refresh',
      rtt,
      refinementObservationId: toRtcRttMutationReceiptId(rtt),
    });
    if (envelope.data.kind !== 'rtt-refresh') {
      throw new Error('Expected canonical durable RTT refresh work');
    }
    const legacyMessage = {
      ...message,
      payload: {
        ...message.payload,
        resource: JSON.stringify({
          ...envelope,
          data: {
            kind: 'group-revision',
            overlayId: envelope.data.overlayId,
            groupSnapshot: envelope.data.groupSnapshot,
            sourceGroupStateRevision: envelope.data.requestedGroupStateRevision,
            requestedAtEpochMs: envelope.data.requestedAtEpochMs,
            requestOptions: envelope.data.requestOptions,
            publish: envelope.data.publish,
          },
        }),
      },
    };
    expect(
      readRtcTopologyWorkEnvelope(legacyMessage, AppOutboxType.RTC_TOPOLOGY_RECOMPUTE).data,
    ).toMatchObject({
      kind: 'legacy-rtt-refresh',
      legacySource: 'durable-group-revision',
      refinementObservationId: toRtcRttMutationReceiptId(rtt),
    });
  });
});

function createRttGroupSnapshot(nowEpochMs: number): GroupSnapshot {
  const groupRef = { ...SCOPE, groupId: 'rtc-room' };
  const audit: AuditStamp = {
    atEpochMs: nowEpochMs,
    actor: { kind: 'principal', principalId: 'alice' },
    reason: null,
    traceId: null,
    requestId: null,
  };
  const sessionIds = ['alice-session', 'bob-session'] as const;
  const members = ['alice', 'bob'].map<GroupMember>((principalId, index) => ({
    ...groupRef,
    principalId,
    role: index === 0 ? 'owner' : 'member',
    status: 'active',
    invitedByPrincipalId: null,
    invitationExpiresAtEpochMs: null,
    left: null,
    removed: null,
    banned: null,
    joined: audit,
    updated: audit,
  }));
  const activeSessions = sessionIds.map<GroupPresenceSession>((sessionId, index) => ({
    ...groupRef,
    sessionId,
    principalId: members[index]!.principalId,
    generationId: `${sessionId}-generation`,
    generationVersion: nowEpochMs - 1,
    connectedAtEpochMs: nowEpochMs - 1,
    lastHeartbeatAtEpochMs: nowEpochMs,
    expiresAtEpochMs: nowEpochMs + 60_000,
    status: 'active',
    disconnectedAtEpochMs: null,
    disconnectReason: null,
  }));
  return {
    stateRevision: 2,
    causalRevision: { groupRevision: 1, presenceRevision: 1 },
    group: {
      ...groupRef,
      slug: null,
      displayName: 'RTC room',
      description: null,
      kind: 'room',
      status: 'active',
      archived: null,
      deleted: null,
      joinMode: 'open',
      metadata: {},
      snapshotVersion: 1,
      metadataVersion: 1,
      rosterVersion: 1,
      presenceVersion: 1,
      activeMemberCount: 2,
      ownerPrincipalId: 'alice',
      maxMembers: null,
      maxSessionsPerMember: null,
      expiresAtEpochMs: null,
      emptySinceEpochMs: null,
      purgeAfterEpochMs: null,
      created: audit,
      updated: audit,
    },
    members,
    activeSessions,
    memberCount: 2,
    onlineMemberCount: 2,
  };
}
