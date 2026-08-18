import { describe, expect, it } from 'vitest';

import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { toGroupSnapshotStateRevision } from '@shared/api/group-client-views.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import { isIdempotentHandlerFinalizedRelease } from '@shared/queuebox/QueueBoxTypes.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { isCanonicalRtcTopologyWorkEntry } from '@shared/queuebox/RtcTopologyWorkEntryContract.ts';
import { AppOutboxType } from '@shared-server/rallar-system/services/AppOutboxService.ts';
import {
  COALESCED_APP_OUTBOX_WORK_FIELD,
  type CoalescedAppOutboxWorkData,
  type CoalescedAppOutboxWorkEnvelope,
} from '@shared-server/rallar-system/services/CoalescedAppOutboxWorkService.ts';
import {
  computeCoalescedRtcTopologyGroupRevisionWork,
  mergeRtcTopologyGroupRevisionWork,
  toRtcTopologyCoalescedGroupRevisionResourceId,
} from '@shared-server/rallar-system/topology/replay/rtc-topology-coalesced-group-revision-work.ts';
import type { RtcTopologyGroupRevisionWork } from '@shared-server/rallar-system/services/RtcTopologyOutboxWork.ts';
import { computeRtcTopologyInputFingerprint } from '@shared-server/rallar-system/topology/replay/rtc-topology-input-fingerprint.ts';
import {
  parsePersistedRtcTopologyALMessage,
  type PersistedRtcTopologyWork,
  readRtcTopologyWorkEnvelope,
  toRtcTopologyExecutionId,
} from '@shared-server/rallar-system/topology/replay/rtc-topology-work-codec.ts';
import { createTestGroup } from '@shared-test/create-test-group.ts';

const GROUP_REF = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  groupId: 'room-1',
} as const;
const OVERLAY_ID = toScopedOverlayId(GROUP_REF);
const BASE_EPOCH_MS = 1_000_000;
const EXPIRE_AT_EPOCH_MS = BASE_EPOCH_MS + 3_600_000;
const DEBOUNCE_MS = 500;

describe('computeCoalescedRtcTopologyGroupRevisionWork', () => {
  it('creates a per-group coalesced entry with debounce scheduling on first intent', () => {
    const computed = computeCoalescedRtcTopologyGroupRevisionWork({
      aggregateRef: GROUP_REF,
      groupSnapshot: createGroupSnapshot(4, 3),
      requestedAtEpochMs: BASE_EPOCH_MS,
      expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
      recomputeDebounceMs: DEBOUNCE_MS,
      senderId: 'server-1',
      previousEntry: null,
    });

    expect(computed.expectedEntry).toBeNull();
    expect(computed.entry.status).toBe(EntityStatus.RETRY);
    expect(computed.entry.dequeueAudit.nextTs?.epochMilliseconds).toBe(BASE_EPOCH_MS + DEBOUNCE_MS);

    const envelope = readPersistedEnvelope(computed.entry);
    expect(envelope.resourceId).toBe(toRtcTopologyCoalescedGroupRevisionResourceId(OVERLAY_ID));
    expect(envelope.resourceId).toBe(`${OVERLAY_ID}:group-revision`);
    expect(envelope.data.kind).toBe('group-revision');
    expect(envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD]).toMatchObject({
      generation: 1,
      requestedAtEpochMs: BASE_EPOCH_MS,
      dueAtEpochMs: BASE_EPOCH_MS + DEBOUNCE_MS,
      reasons: ['group-revision'],
    });
    expect(toRtcTopologyExecutionId(envelope)).toContain(':1');
  });

  it('is due immediately with a zero debounce', () => {
    const computed = computeCoalescedRtcTopologyGroupRevisionWork({
      aggregateRef: GROUP_REF,
      groupSnapshot: createGroupSnapshot(4, 3),
      requestedAtEpochMs: BASE_EPOCH_MS,
      expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
      recomputeDebounceMs: 0,
      senderId: 'server-1',
      previousEntry: null,
    });

    expect(computed.entry.status).toBe(EntityStatus.NEW);
    expect(computed.entry.dequeueAudit.nextTs).toBeUndefined();
  });

  it('merges onto a pending predecessor: max revision, sliding due, one generation up', () => {
    const first = computeCoalescedRtcTopologyGroupRevisionWork({
      aggregateRef: GROUP_REF,
      groupSnapshot: createGroupSnapshot(4, 3),
      requestedAtEpochMs: BASE_EPOCH_MS,
      expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
      recomputeDebounceMs: DEBOUNCE_MS,
      senderId: 'server-1',
      previousEntry: null,
    });
    const second = computeCoalescedRtcTopologyGroupRevisionWork({
      aggregateRef: GROUP_REF,
      groupSnapshot: createGroupSnapshot(4, 5),
      requestedAtEpochMs: BASE_EPOCH_MS + 200,
      expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
      recomputeDebounceMs: DEBOUNCE_MS,
      senderId: 'server-1',
      previousEntry: first.entry,
    });

    expect(second.expectedEntry).toBe(first.entry);
    const envelope = readPersistedGroupRevisionEnvelope(second.entry);
    expect(envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD]).toMatchObject({
      generation: 2,
      dueAtEpochMs: BASE_EPOCH_MS + 200 + DEBOUNCE_MS,
    });
    expect(envelope.data.sourceGroupStateRevision).toBe(toGroupSnapshotStateRevision(4, 5));
    expect(second.entry.status).toBe(EntityStatus.RETRY);
    expect(second.entry.dequeueAudit.attempts).toBe(first.entry.dequeueAudit.attempts);
  });

  it('keeps merged generations canonical so handler-finalized releases stay idempotent', () => {
    const unexpiredBaseEpochMs = 1_800_000_000_000;
    const unexpiredExpireAtEpochMs = unexpiredBaseEpochMs + 3_600_000;
    const first = computeCoalescedRtcTopologyGroupRevisionWork({
      aggregateRef: GROUP_REF,
      groupSnapshot: createGroupSnapshot(4, 3),
      requestedAtEpochMs: unexpiredBaseEpochMs,
      expireAtEpochMs: unexpiredExpireAtEpochMs,
      recomputeDebounceMs: DEBOUNCE_MS,
      senderId: 'server-1',
      previousEntry: null,
    });
    const second = computeCoalescedRtcTopologyGroupRevisionWork({
      aggregateRef: GROUP_REF,
      groupSnapshot: createGroupSnapshot(4, 5),
      requestedAtEpochMs: unexpiredBaseEpochMs + 200,
      expireAtEpochMs: unexpiredExpireAtEpochMs + 200,
      recomputeDebounceMs: DEBOUNCE_MS,
      senderId: 'server-1',
      previousEntry: first.entry,
    });
    const merged = JSON.parse(second.entry.resource) as {
      id: { ts: number };
      audit: { createdTs: number };
      constraints: { expiresAtMs: number };
    };

    expect(merged.id.ts).toBe(unexpiredBaseEpochMs);
    expect(merged.audit.createdTs).toBe(unexpiredBaseEpochMs);
    expect(merged.constraints.expiresAtMs).toBe(unexpiredExpireAtEpochMs);
    expect(isCanonicalRtcTopologyWorkEntry(second.entry)).toBe(true);

    const reserved: ResourceEntry = {
      ...second.entry,
      status: EntityStatus.RESERVED,
      dequeueAudit: { attempts: 1 },
    };
    const finalized: ResourceEntry = {
      ...second.entry,
      status: EntityStatus.COMPLETED,
      dequeueAudit: { attempts: 1 },
    };
    expect(
      isIdempotentHandlerFinalizedRelease(finalized, reserved, {
        status: EntityStatus.COMPLETED,
        delayMs: null,
      }),
    ).toBe(true);
  });

  it('keeps the original message identity through a terminal revival', () => {
    const unexpiredBaseEpochMs = 1_800_000_000_000;
    const unexpiredExpireAtEpochMs = unexpiredBaseEpochMs + 3_600_000;
    const first = computeCoalescedRtcTopologyGroupRevisionWork({
      aggregateRef: GROUP_REF,
      groupSnapshot: createGroupSnapshot(4, 3),
      requestedAtEpochMs: unexpiredBaseEpochMs,
      expireAtEpochMs: unexpiredExpireAtEpochMs,
      recomputeDebounceMs: DEBOUNCE_MS,
      senderId: 'server-1',
      previousEntry: null,
    });
    const completedFirst: ResourceEntry = {
      ...first.entry,
      status: EntityStatus.COMPLETED,
      dequeueAudit: { attempts: 1 },
    };
    const revived = computeCoalescedRtcTopologyGroupRevisionWork({
      aggregateRef: GROUP_REF,
      groupSnapshot: createGroupSnapshot(4, 5),
      requestedAtEpochMs: unexpiredBaseEpochMs + 5_000,
      expireAtEpochMs: unexpiredExpireAtEpochMs + 5_000,
      recomputeDebounceMs: DEBOUNCE_MS,
      senderId: 'server-1',
      previousEntry: completedFirst,
    });
    const revivedMessage = JSON.parse(revived.entry.resource) as {
      id: { ts: number };
      constraints: { expiresAtMs: number };
    };

    expect(revived.entry.dequeueAudit.attempts).toBe(0);
    expect(revivedMessage.id.ts).toBe(unexpiredBaseEpochMs);
    expect(revivedMessage.constraints.expiresAtMs).toBe(unexpiredExpireAtEpochMs);
    expect(revived.entry.audit).toEqual(first.entry.audit);
    expect(isCanonicalRtcTopologyWorkEntry(revived.entry)).toBe(true);
  });

  it('keeps the newer predecessor snapshot when the incoming revision is older', () => {
    const newer = createCoalescedData(createGroupSnapshot(4, 6), BASE_EPOCH_MS + 100);
    const older = createCoalescedData(createGroupSnapshot(4, 5), BASE_EPOCH_MS + 300);

    const merged = mergeRtcTopologyGroupRevisionWork(newer, older);

    expect(merged.sourceGroupStateRevision).toBe(toGroupSnapshotStateRevision(4, 6));
    expect(merged.groupSnapshot).toBe(newer.groupSnapshot);
    expect(merged.requestedAtEpochMs).toBe(BASE_EPOCH_MS + 300);
    expect(merged[COALESCED_APP_OUTBOX_WORK_FIELD].dueAtEpochMs).toBe(
      BASE_EPOCH_MS + 300 + DEBOUNCE_MS,
    );
  });

  it('replaces without merging over a completed predecessor and resets lifecycle', () => {
    const first = computeCoalescedRtcTopologyGroupRevisionWork({
      aggregateRef: GROUP_REF,
      groupSnapshot: createGroupSnapshot(4, 3),
      requestedAtEpochMs: BASE_EPOCH_MS,
      expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
      recomputeDebounceMs: DEBOUNCE_MS,
      senderId: 'server-1',
      previousEntry: null,
    });
    const completed: ResourceEntry = {
      ...first.entry,
      status: EntityStatus.COMPLETED,
      dequeueAudit: { attempts: 3 },
    };

    const revived = computeCoalescedRtcTopologyGroupRevisionWork({
      aggregateRef: GROUP_REF,
      groupSnapshot: createGroupSnapshot(5, 5),
      requestedAtEpochMs: BASE_EPOCH_MS + 60_000,
      expireAtEpochMs: EXPIRE_AT_EPOCH_MS + 60_000,
      recomputeDebounceMs: DEBOUNCE_MS,
      senderId: 'server-1',
      previousEntry: completed,
    });

    const envelope = readPersistedGroupRevisionEnvelope(revived.entry);
    expect(envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD]).toMatchObject({
      generation: 2,
      dueAtEpochMs: BASE_EPOCH_MS + 60_000 + DEBOUNCE_MS,
      reasons: ['group-revision'],
    });
    expect(envelope.data.sourceGroupStateRevision).toBe(toGroupSnapshotStateRevision(5, 5));
    expect(revived.entry.dequeueAudit.attempts).toBe(0);
  });

  it('always carries a deterministic per-revision successor identity', () => {
    const first = computeCoalescedRtcTopologyGroupRevisionWork({
      aggregateRef: GROUP_REF,
      groupSnapshot: createGroupSnapshot(4, 3),
      requestedAtEpochMs: BASE_EPOCH_MS,
      expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
      recomputeDebounceMs: DEBOUNCE_MS,
      senderId: 'server-1',
      previousEntry: null,
    });
    const reserved: ResourceEntry = { ...first.entry, status: EntityStatus.RESERVED };

    const blocked = computeCoalescedRtcTopologyGroupRevisionWork({
      aggregateRef: GROUP_REF,
      groupSnapshot: createGroupSnapshot(4, 5),
      requestedAtEpochMs: BASE_EPOCH_MS + 1_000,
      expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
      recomputeDebounceMs: DEBOUNCE_MS,
      senderId: 'server-1',
      previousEntry: reserved,
    });

    const stateRevision = toGroupSnapshotStateRevision(4, 5);
    const successorEnvelope = readPersistedGroupRevisionEnvelope(blocked.successorEntry);
    expect(successorEnvelope.resourceId).toBe(`${OVERLAY_ID}:group-revision:r${stateRevision}`);
    expect(successorEnvelope.data[COALESCED_APP_OUTBOX_WORK_FIELD].generation).toBe(1);
    expect(successorEnvelope.data.sourceGroupStateRevision).toBe(stateRevision);
    const mainEnvelope = readPersistedGroupRevisionEnvelope(blocked.entry);
    expect(mainEnvelope.data[COALESCED_APP_OUTBOX_WORK_FIELD].generation).toBe(2);
  });

  it('fails closed when the predecessor is not coalesced topology work', () => {
    const first = computeCoalescedRtcTopologyGroupRevisionWork({
      aggregateRef: GROUP_REF,
      groupSnapshot: createGroupSnapshot(4, 3),
      requestedAtEpochMs: BASE_EPOCH_MS,
      expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
      recomputeDebounceMs: DEBOUNCE_MS,
      senderId: 'server-1',
      previousEntry: null,
    });
    const corrupted: ResourceEntry = { ...first.entry, resource: '{"not":"a message"}' };

    expect(() =>
      computeCoalescedRtcTopologyGroupRevisionWork({
        aggregateRef: GROUP_REF,
        groupSnapshot: createGroupSnapshot(4, 5),
        requestedAtEpochMs: BASE_EPOCH_MS + 1_000,
        expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
        recomputeDebounceMs: DEBOUNCE_MS,
        senderId: 'server-1',
        previousEntry: corrupted,
      }),
    ).toThrow(/not coalesced topology work/);
  });
});

function readPersistedEnvelope(entry: ResourceEntry) {
  return readRtcTopologyWorkEnvelope(
    parsePersistedRtcTopologyALMessage(entry.resource),
    AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
  );
}

function readPersistedGroupRevisionEnvelope(
  entry: ResourceEntry,
): CoalescedAppOutboxWorkEnvelope<RtcTopologyGroupRevisionWork> {
  const envelope = readPersistedEnvelope(entry);
  const work = envelope.data;
  if (!isCoalescedGroupRevisionWork(work)) {
    throw new TypeError(
      `Persisted entry is not coalesced group-revision work: ${envelope.resourceId}`,
    );
  }
  return { ...envelope, data: work };
}

function isCoalescedGroupRevisionWork(
  work: PersistedRtcTopologyWork,
): work is CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork> {
  return work.kind === 'group-revision' && work[COALESCED_APP_OUTBOX_WORK_FIELD] !== undefined;
}

function createCoalescedData(
  groupSnapshot: GroupSnapshot,
  requestedAtEpochMs: number,
): CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork> {
  return {
    kind: 'group-revision',
    overlayId: OVERLAY_ID,
    groupSnapshot,
    sourceGroupStateRevision: groupSnapshot.stateRevision,
    requestedAtEpochMs,
    requestOptions: toCanonicalGroupTopologyConfigPatch({}),
    publish: true,
    [COALESCED_APP_OUTBOX_WORK_FIELD]: {
      generation: 1,
      requestedAtEpochMs,
      dueAtEpochMs: requestedAtEpochMs + DEBOUNCE_MS,
      reasons: ['group-revision'],
    },
  };
}

function createGroupSnapshot(groupRevision: number, presenceRevision: number): GroupSnapshot {
  const audit = createAuditStamp();
  return {
    stateRevision: toGroupSnapshotStateRevision(groupRevision, presenceRevision),
    causalRevision: { groupRevision, presenceRevision },
    group: createTestGroup({
      ...GROUP_REF,
      displayName: 'Room 1',
      activeMemberCount: 1,
      ownerPrincipalId: 'alice',
      snapshotVersion: groupRevision,
      metadataVersion: groupRevision,
      rosterVersion: groupRevision,
      presenceVersion: presenceRevision,
      created: audit,
      updated: audit,
    }),
    members: [
      {
        ...GROUP_REF,
        principalId: 'alice',
        role: 'owner',
        status: 'active',
        joined: audit,
        updated: audit,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null,
      },
    ],
    activeSessions: [
      {
        ...GROUP_REF,
        principalId: 'alice',
        sessionId: 'session-alice',
        generationId: 'generation-alice',
        generationVersion: 1,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: EXPIRE_AT_EPOCH_MS,
      },
    ],
    memberCount: 1,
    onlineMemberCount: 1,
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

describe('computeRtcTopologyInputFingerprint', () => {
  const EFFECTIVE_CONFIG = {
    topologyKind: 'auto',
    degreeLimit: 5,
    treeMinSize: 5,
    meshMinSize: 16,
    meshParamK: 2,
  } as const;
  const KIND_HYSTERESIS_WIDTHS = { meshExitWidth: 4, treeExitWidth: 0 } as const;

  it('is deterministic and insensitive to session order', async () => {
    const forward = await computeRtcTopologyInputFingerprint({
      group: withSessions(createGroupSnapshot(4, 3), ['session-a', 'session-b']),
      effectiveConfig: EFFECTIVE_CONFIG,
      kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
    });
    const reversed = await computeRtcTopologyInputFingerprint({
      group: withSessions(createGroupSnapshot(4, 3), ['session-b', 'session-a']),
      effectiveConfig: EFFECTIVE_CONFIG,
      kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
    });

    expect(forward).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(reversed).toBe(forward);
  });

  it('changes when sessions, display name, or effective config change', async () => {
    const base = await computeRtcTopologyInputFingerprint({
      group: withSessions(createGroupSnapshot(4, 3), ['session-a', 'session-b']),
      effectiveConfig: EFFECTIVE_CONFIG,
      kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
    });
    const grownSessions = await computeRtcTopologyInputFingerprint({
      group: withSessions(createGroupSnapshot(4, 3), ['session-a', 'session-b', 'session-c']),
      effectiveConfig: EFFECTIVE_CONFIG,
      kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
    });
    const renamedGroup = createGroupSnapshot(4, 3);
    const renamed = await computeRtcTopologyInputFingerprint({
      group: {
        ...renamedGroup,
        group: { ...renamedGroup.group, displayName: 'Renamed room' },
      },
      effectiveConfig: EFFECTIVE_CONFIG,
      kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
    });
    const reconfigured = await computeRtcTopologyInputFingerprint({
      group: createGroupSnapshot(4, 3),
      effectiveConfig: { ...EFFECTIVE_CONFIG, degreeLimit: 4 },
      kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
    });

    expect(new Set([base, grownSessions, renamed, reconfigured]).size).toBe(4);
  });

  it('ignores lease-only differences between identical session sets', async () => {
    const snapshot = createGroupSnapshot(4, 3);
    const renewed: GroupSnapshot = {
      ...snapshot,
      activeSessions: snapshot.activeSessions.map((session) => ({
        ...session,
        lastHeartbeatAtEpochMs: session.lastHeartbeatAtEpochMs + 30_000,
        expiresAtEpochMs: session.expiresAtEpochMs + 30_000,
      })),
    };

    expect(
      await computeRtcTopologyInputFingerprint({
        group: renewed,
        effectiveConfig: EFFECTIVE_CONFIG,
        kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
      }),
    ).toBe(
      await computeRtcTopologyInputFingerprint({
        group: snapshot,
        effectiveConfig: EFFECTIVE_CONFIG,
        kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
      }),
    );
  });
});

function withSessions(snapshot: GroupSnapshot, sessionIds: readonly string[]): GroupSnapshot {
  return {
    ...snapshot,
    activeSessions: sessionIds.map((sessionId) => ({
      ...snapshot.activeSessions[0]!,
      sessionId,
    })),
  };
}
