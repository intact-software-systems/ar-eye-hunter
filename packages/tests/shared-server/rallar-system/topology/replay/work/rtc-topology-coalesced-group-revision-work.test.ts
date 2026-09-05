import { describe, expect, it } from 'vitest';

import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    type CoalescedAppOutboxWorkData,
    type CoalescedAppOutboxWorkEnvelope
} from '@shared-server/rallar-system/app-outbox/coalesced-app-outbox-work-service.ts';
import type { RtcTopologyGroupRevisionWork } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-work.ts';
import {
    computeCoalescedRtcTopologyGroupRevisionWork,
    computeTopologyReplanDueAt,
    isChangeGatedGroupRevisionWork,
    mergeRtcTopologyGroupRevisionWork,
    readPendingTopologyReplan,
    toRtcTopologyCoalescedGroupRevisionResourceId,
    type TopologyReplanTiming
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { computeRtcTopologyInputFingerprint } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-input-fingerprint.ts';
import {
    readRtcTopologyWorkEnvelope,
    toRtcTopologyExecutionId,
    type PersistedRtcTopologyWork
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-codec.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import { isIdempotentHandlerFinalizedRelease } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { isCanonicalRtcTopologyWorkEntry } from '@shared/queuebox/rtc-topology-work-entry-contract.ts';
import { createTestGroup } from '../../../../../create-test-group.ts';

const GROUP_REF = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
} as const;
const OVERLAY_ID = toScopedOverlayId(GROUP_REF);
const BASE_EPOCH_MS = 1_000_000;
const EXPIRE_AT_EPOCH_MS = BASE_EPOCH_MS + 3_600_000;
const DEBOUNCE_MS = 500;

/** The server window alone: no maximum wait, no layout ageing. */
function createUnboundedTopologyReplanTiming(debounceMs: number): TopologyReplanTiming {
    return { window: { debounceMs, maxWaitMs: null }, replanNotBeforeEpochMs: null };
}

describe('computeCoalescedRtcTopologyGroupRevisionWork', () => {
    it('keeps a commanded reconfigure outside the automatic change gate', () => {
        const computed = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, 3),
            requestedAtEpochMs: BASE_EPOCH_MS,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: 'commanded',
            previousEntry: null
        });

        const envelope = readPersistedGroupRevisionEnvelope(computed.entryWrite.entry);
        expect(envelope.data.origin).toBe('commanded');
        expect(isChangeGatedGroupRevisionWork(envelope.data)).toBe(false);
    });

    it.each(
        [
            ['commanded', 'automatic'],
            ['automatic', 'commanded']
        ] as const
    )('keeps commanded origin when %s work is followed by %s work', (firstOrigin, secondOrigin) => {
        const first = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, 3),
            requestedAtEpochMs: BASE_EPOCH_MS,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: firstOrigin,
            previousEntry: null
        });
        const second = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, 4),
            requestedAtEpochMs: BASE_EPOCH_MS + 1,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: secondOrigin,
            previousEntry: first.entryWrite.entry
        });

        expect(readPersistedGroupRevisionEnvelope(second.entryWrite.entry).data.origin).toBe('commanded');
    });

    it('creates a per-group coalesced entry with debounce scheduling on first intent', () => {
        const computed = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, 3),
            requestedAtEpochMs: BASE_EPOCH_MS,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: 'automatic',
            previousEntry: null
        });

        expect(computed.expectedEntry).toBeNull();
        expect(computed.entryWrite.entry.status).toBe(EntityStatus.RETRY);
        expect(computed.entryWrite.entry.dequeueAudit.nextTs?.epochMilliseconds).toBe(BASE_EPOCH_MS + DEBOUNCE_MS);

        const envelope = readPersistedEnvelope(computed.entryWrite.entry);
        expect(envelope.resourceId).toBe(toRtcTopologyCoalescedGroupRevisionResourceId(OVERLAY_ID));
        expect(envelope.resourceId).toBe(`${OVERLAY_ID}:group-revision`);
        expect(envelope.data.kind).toBe('group-revision');
        expect(envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD]).toMatchObject({
            generation: 1,
            requestedAtEpochMs: BASE_EPOCH_MS,
            dueAtEpochMs: BASE_EPOCH_MS + DEBOUNCE_MS,
            reasons: ['group-revision']
        });
        expect(toRtcTopologyExecutionId(envelope)).toContain(':1');
    });

    it('is due immediately with a zero debounce', () => {
        const computed = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, 3),
            requestedAtEpochMs: BASE_EPOCH_MS,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
            timing: createUnboundedTopologyReplanTiming(0),
            senderId: 'server-1',
            origin: 'automatic',
            previousEntry: null
        });

        expect(computed.entryWrite.entry.status).toBe(EntityStatus.NEW);
        expect(computed.entryWrite.entry.dequeueAudit.nextTs).toBeUndefined();
    });

    it('merges onto a pending predecessor: max revision, sliding due, one generation up', () => {
        const first = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, 3),
            requestedAtEpochMs: BASE_EPOCH_MS,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: 'automatic',
            previousEntry: null
        });
        const second = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, 5),
            requestedAtEpochMs: BASE_EPOCH_MS + 200,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: 'automatic',
            previousEntry: first.entryWrite.entry
        });

        expect(second.expectedEntry).toBe(first.entryWrite.entry);
        const envelope = readPersistedGroupRevisionEnvelope(second.entryWrite.entry);
        expect(envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD]).toMatchObject({
            generation: 2,
            dueAtEpochMs: BASE_EPOCH_MS + 200 + DEBOUNCE_MS
        });
        expect(envelope.data.sourceGroupStateCausalRevision).toEqual({
            groupRevision: 4,
            presenceRevision: 5
        });
        expect(second.entryWrite.entry.status).toBe(EntityStatus.RETRY);
        expect(second.entryWrite.entry.dequeueAudit.attempts).toBe(first.entryWrite.entry.dequeueAudit.attempts);
    });

    it('keeps merged generations canonical so handler-finalized releases stay idempotent', () => {
        const unexpiredBaseEpochMs = 1_800_000_000_000;
        const unexpiredExpireAtEpochMs = unexpiredBaseEpochMs + 3_600_000;
        const first = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, 3),
            requestedAtEpochMs: unexpiredBaseEpochMs,
            expireAtEpochMs: unexpiredExpireAtEpochMs,
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: 'automatic',
            previousEntry: null
        });
        const second = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, 5),
            requestedAtEpochMs: unexpiredBaseEpochMs + 200,
            expireAtEpochMs: unexpiredExpireAtEpochMs + 200,
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: 'automatic',
            previousEntry: first.entryWrite.entry
        });
        const merged = JSON.parse(second.entryWrite.entry.resource) as {
            id: { ts: number; };
            audit: { createdTs: number; };
            constraints: { expiresAtMs: number; };
        };

        expect(merged.id.ts).toBe(unexpiredBaseEpochMs);
        expect(merged.audit.createdTs).toBe(unexpiredBaseEpochMs);
        expect(merged.constraints.expiresAtMs).toBe(unexpiredExpireAtEpochMs);
        expect(isCanonicalRtcTopologyWorkEntry(second.entryWrite.entry)).toBe(true);

        const reserved: ResourceEntry = {
            ...second.entryWrite.entry,
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 1 }
        };
        const finalized: ResourceEntry = {
            ...second.entryWrite.entry,
            status: EntityStatus.COMPLETED,
            dequeueAudit: { attempts: 1 }
        };
        expect(
            isIdempotentHandlerFinalizedRelease(finalized, reserved, {
                status: EntityStatus.COMPLETED,
                delayMs: null
            })
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
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: 'automatic',
            previousEntry: null
        });
        const completedFirst: ResourceEntry = {
            ...first.entryWrite.entry,
            status: EntityStatus.COMPLETED,
            dequeueAudit: { attempts: 1 }
        };
        const revived = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, 5),
            requestedAtEpochMs: unexpiredBaseEpochMs + 5_000,
            expireAtEpochMs: unexpiredExpireAtEpochMs + 5_000,
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: 'automatic',
            previousEntry: completedFirst
        });
        const revivedMessage = JSON.parse(revived.entryWrite.entry.resource) as {
            id: { ts: number; };
            constraints: { expiresAtMs: number; };
        };

        expect(revived.entryWrite.entry.dequeueAudit.attempts).toBe(0);
        expect(revivedMessage.id.ts).toBe(unexpiredBaseEpochMs);
        expect(revivedMessage.constraints.expiresAtMs).toBe(unexpiredExpireAtEpochMs);
        expect(revived.entryWrite.entry.audit).toEqual(first.entryWrite.entry.audit);
        expect(isCanonicalRtcTopologyWorkEntry(revived.entryWrite.entry)).toBe(true);
    });

    it('keeps the newer predecessor snapshot when the incoming revision is older', () => {
        const newer = createCoalescedData(createGroupSnapshot(4, 6), BASE_EPOCH_MS + 100);
        const older = createCoalescedData(createGroupSnapshot(4, 5), BASE_EPOCH_MS + 300);

        const merged = mergeRtcTopologyGroupRevisionWork(newer, older, createUnboundedTopologyReplanTiming(DEBOUNCE_MS));

        expect(merged.sourceGroupStateCausalRevision).toEqual({
            groupRevision: 4,
            presenceRevision: 6
        });
        expect(merged.groupSnapshot).toBe(newer.groupSnapshot);
        expect(merged.requestedAtEpochMs).toBe(BASE_EPOCH_MS + 300);
        expect(merged[COALESCED_APP_OUTBOX_WORK_FIELD].dueAtEpochMs).toBe(
            BASE_EPOCH_MS + 300 + DEBOUNCE_MS
        );
    });

    it('replaces without merging over a completed predecessor and resets lifecycle', () => {
        const first = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, 3),
            requestedAtEpochMs: BASE_EPOCH_MS,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: 'automatic',
            previousEntry: null
        });
        const completed: ResourceEntry = {
            ...first.entryWrite.entry,
            status: EntityStatus.COMPLETED,
            dequeueAudit: { attempts: 3 }
        };

        const revived = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(5, 5),
            requestedAtEpochMs: BASE_EPOCH_MS + 60_000,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS + 60_000,
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: 'automatic',
            previousEntry: completed
        });

        const envelope = readPersistedGroupRevisionEnvelope(revived.entryWrite.entry);
        expect(envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD]).toMatchObject({
            generation: 2,
            dueAtEpochMs: BASE_EPOCH_MS + 60_000 + DEBOUNCE_MS,
            reasons: ['group-revision']
        });
        expect(envelope.data.sourceGroupStateCausalRevision).toEqual({
            groupRevision: 5,
            presenceRevision: 5
        });
        expect(revived.entryWrite.entry.dequeueAudit.attempts).toBe(0);
    });

    it('always carries a deterministic per-revision successor identity', () => {
        const first = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, 3),
            requestedAtEpochMs: BASE_EPOCH_MS,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: 'automatic',
            previousEntry: null
        });
        const reserved: ResourceEntry = { ...first.entryWrite.entry, status: EntityStatus.RESERVED };

        const blocked = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, 5),
            requestedAtEpochMs: BASE_EPOCH_MS + 1_000,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: 'automatic',
            previousEntry: reserved
        });

        const successorEnvelope = readPersistedGroupRevisionEnvelope(blocked.successorWrite.entry);
        expect(successorEnvelope.resourceId).toBe(
            `${OVERLAY_ID}:group-revision:group=4;presence=5`
        );
        expect(successorEnvelope.data[COALESCED_APP_OUTBOX_WORK_FIELD].generation).toBe(1);
        expect(successorEnvelope.data.sourceGroupStateCausalRevision).toEqual({
            groupRevision: 4,
            presenceRevision: 5
        });
        const mainEnvelope = readPersistedGroupRevisionEnvelope(blocked.entryWrite.entry);
        expect(mainEnvelope.data[COALESCED_APP_OUTBOX_WORK_FIELD].generation).toBe(2);
    });

    it('fails closed when the predecessor is not coalesced topology work', () => {
        const first = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, 3),
            requestedAtEpochMs: BASE_EPOCH_MS,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: 'automatic',
            previousEntry: null
        });
        const corrupted: ResourceEntry = { ...first.entryWrite.entry, resource: '{"not":"a message"}' };

        expect(() =>
            computeCoalescedRtcTopologyGroupRevisionWork({
                aggregateRef: GROUP_REF,
                groupSnapshot: createGroupSnapshot(4, 5),
                requestedAtEpochMs: BASE_EPOCH_MS + 1_000,
                expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
                timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
                senderId: 'server-1',
                origin: 'automatic',
                previousEntry: corrupted
            })
        ).toThrow(/not coalesced topology work/);
    });
});

function readPersistedEnvelope(entry: ResourceEntry) {
    return readRtcTopologyWorkEnvelope(
        decodePersistedALMessage(entry.resource),
        AppOutboxType.RTC_TOPOLOGY_RECOMPUTE
    );
}

function readPersistedGroupRevisionEnvelope(
    entry: ResourceEntry
): CoalescedAppOutboxWorkEnvelope<RtcTopologyGroupRevisionWork> {
    const envelope = readPersistedEnvelope(entry);
    const work = envelope.data;
    if (!isCoalescedGroupRevisionWork(work)) {
        throw new TypeError(
            `Persisted entry is not coalesced group-revision work: ${envelope.resourceId}`
        );
    }
    return { ...envelope, data: work };
}

function isCoalescedGroupRevisionWork(
    work: PersistedRtcTopologyWork
): work is CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork> {
    return work.kind === 'group-revision' && work[COALESCED_APP_OUTBOX_WORK_FIELD] !== undefined;
}

function createCoalescedData(
    groupSnapshot: GroupSnapshot,
    requestedAtEpochMs: number
): CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork> {
    return {
        kind: 'group-revision',
        overlayId: OVERLAY_ID,
        groupSnapshot,
        sourceGroupStateCausalRevision: groupSnapshot.causalRevision,
        requestedAtEpochMs,
        requestOptions: toCanonicalGroupTopologyConfigPatch({}),
        publish: true,
        origin: 'automatic',
        [COALESCED_APP_OUTBOX_WORK_FIELD]: {
            generation: 1,
            requestedAtEpochMs,
            windowOpenedAtEpochMs: requestedAtEpochMs,
            dueAtEpochMs: requestedAtEpochMs + DEBOUNCE_MS,
            reasons: ['group-revision']
        }
    };
}

function createGroupSnapshot(groupRevision: number, presenceRevision: number): GroupSnapshot {
    const audit = createAuditStamp();
    return {
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
            updated: audit
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
                banned: null
            }
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
                expiresAtEpochMs: EXPIRE_AT_EPOCH_MS
            }
        ],
        memberCount: 1,
        onlineMemberCount: 1
    };
}

function createAuditStamp(): AuditStamp {
    return {
        atEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}

describe('computeRtcTopologyInputFingerprint', () => {
    const EFFECTIVE_CONFIG = {
        topologyKind: 'auto',
        degreeLimit: 5,
        treeMinSize: 5,
        meshMinSize: 16,
        meshParamK: 2
    } as const;
    const KIND_HYSTERESIS_WIDTHS = { meshExitWidth: 4, treeExitWidth: 0 } as const;

    it('is deterministic and insensitive to session order', async () => {
        const forward = await computeRtcTopologyInputFingerprint({
            group: withSessions(createGroupSnapshot(4, 3), ['session-a', 'session-b']),
            effectiveConfig: EFFECTIVE_CONFIG,
            kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
            rttReportingDegreeLimit: 5
        });
        const reversed = await computeRtcTopologyInputFingerprint({
            group: withSessions(createGroupSnapshot(4, 3), ['session-b', 'session-a']),
            effectiveConfig: EFFECTIVE_CONFIG,
            kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
            rttReportingDegreeLimit: 5
        });

        expect(forward).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(reversed).toBe(forward);
    });

    it('changes when sessions, display name, or effective config change', async () => {
        const base = await computeRtcTopologyInputFingerprint({
            group: withSessions(createGroupSnapshot(4, 3), ['session-a', 'session-b']),
            effectiveConfig: EFFECTIVE_CONFIG,
            kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
            rttReportingDegreeLimit: 5
        });
        const grownSessions = await computeRtcTopologyInputFingerprint({
            group: withSessions(createGroupSnapshot(4, 3), ['session-a', 'session-b', 'session-c']),
            effectiveConfig: EFFECTIVE_CONFIG,
            kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
            rttReportingDegreeLimit: 5
        });
        const renamedGroup = createGroupSnapshot(4, 3);
        const renamed = await computeRtcTopologyInputFingerprint({
            group: {
                ...renamedGroup,
                group: { ...renamedGroup.group, displayName: 'Renamed room' }
            },
            effectiveConfig: EFFECTIVE_CONFIG,
            kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
            rttReportingDegreeLimit: 5
        });
        const reconfigured = await computeRtcTopologyInputFingerprint({
            group: createGroupSnapshot(4, 3),
            effectiveConfig: { ...EFFECTIVE_CONFIG, degreeLimit: 4 },
            kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
            rttReportingDegreeLimit: 5
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
                expiresAtEpochMs: session.expiresAtEpochMs + 30_000
            }))
        };

        expect(
            await computeRtcTopologyInputFingerprint({
                group: renewed,
                effectiveConfig: EFFECTIVE_CONFIG,
                kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
                rttReportingDegreeLimit: 5
            })
        ).toBe(
            await computeRtcTopologyInputFingerprint({
                group: snapshot,
                effectiveConfig: EFFECTIVE_CONFIG,
                kindHysteresisWidths: KIND_HYSTERESIS_WIDTHS,
                rttReportingDegreeLimit: 5
            })
        );
    });
});

function withSessions(snapshot: GroupSnapshot, sessionIds: readonly string[]): GroupSnapshot {
    return {
        ...snapshot,
        activeSessions: sessionIds.map((sessionId) => ({
            ...snapshot.activeSessions[0]!,
            sessionId
        }))
    };
}

describe('readPendingTopologyReplan', () => {
    function computedEntry(): ResourceEntry {
        return computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, 3),
            requestedAtEpochMs: BASE_EPOCH_MS,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS),
            senderId: 'server-1',
            origin: 'automatic',
            previousEntry: null
        }).entryWrite.entry;
    }

    it('reads a queued replan and its due time off the coalesced row', async () => {
        await expect(
            readPendingTopologyReplan({ findByKey: async () => computedEntry() }, GROUP_REF)
        ).resolves.toEqual({
            reconfigureQueued: true,
            dueAtEpochMs: BASE_EPOCH_MS + DEBOUNCE_MS,
            generation: 1
        });
    });

    it('reads null when no row exists and asks with the stored row\'s exact key', async () => {
        const keys: Key[] = [];
        await expect(
            readPendingTopologyReplan({
                findByKey: async (key) => {
                    keys.push(key);
                    return null;
                }
            }, GROUP_REF)
        ).resolves.toBeNull();
        expect(keys).toEqual([computedEntry().key]);
    });

    it('reads an executing (reserved) row as still queued', async () => {
        const reserved = { ...computedEntry(), status: EntityStatus.RESERVED };
        await expect(
            readPendingTopologyReplan({ findByKey: async () => reserved }, GROUP_REF)
        ).resolves.toEqual({
            reconfigureQueued: true,
            dueAtEpochMs: BASE_EPOCH_MS + DEBOUNCE_MS,
            generation: 1
        });
    });

    it('reads a settled row as no pending work', async () => {
        const settled = { ...computedEntry(), status: EntityStatus.COMPLETED };
        await expect(
            readPendingTopologyReplan({ findByKey: async () => settled }, GROUP_REF)
        ).resolves.toBeNull();
    });

    it('reports a queued replan with an unknown due time when the envelope no longer decodes', async () => {
        const corrupt = { ...computedEntry(), resource: '{"not":"an-envelope"}' };
        await expect(
            readPendingTopologyReplan({ findByKey: async () => corrupt }, GROUP_REF)
        ).resolves.toEqual({ reconfigureQueued: true, dueAtEpochMs: null, generation: null });
    });
});

describe('computeTopologyReplanDueAt', () => {
    const timing: TopologyReplanTiming = {
        window: { debounceMs: 500, maxWaitMs: 2_000 },
        replanNotBeforeEpochMs: null
    };

    it('extends the window with each change until the series reaches its maximum wait', () => {
        const opened = BASE_EPOCH_MS;
        const first = computeTopologyReplanDueAt({ requestedAtEpochMs: opened, previous: null, timing });
        expect(first).toBe(opened + 500);
        const extended = computeTopologyReplanDueAt({
            requestedAtEpochMs: opened + 400,
            previous: { windowOpenedAtEpochMs: opened, dueAtEpochMs: first },
            timing
        });
        expect(extended).toBe(opened + 900);
        const bounded = computeTopologyReplanDueAt({
            requestedAtEpochMs: opened + 1_900,
            previous: { windowOpenedAtEpochMs: opened, dueAtEpochMs: extended },
            timing
        });
        expect(bounded).toBe(opened + 2_000);
    });

    it('floors the due time at the planned layout\'s minimum age, even past the maximum wait', () => {
        const opened = BASE_EPOCH_MS;
        expect(computeTopologyReplanDueAt({
            requestedAtEpochMs: opened + 2_500,
            previous: { windowOpenedAtEpochMs: opened, dueAtEpochMs: opened + 2_000 },
            timing: { ...timing, replanNotBeforeEpochMs: opened + 3_400 }
        })).toBe(opened + 3_400);
    });

    it('keeps extending without limit when the window is unbounded', () => {
        expect(computeTopologyReplanDueAt({
            requestedAtEpochMs: BASE_EPOCH_MS + 60_000,
            previous: { windowOpenedAtEpochMs: BASE_EPOCH_MS, dueAtEpochMs: BASE_EPOCH_MS + 500 },
            timing: createUnboundedTopologyReplanTiming(DEBOUNCE_MS)
        })).toBe(BASE_EPOCH_MS + 60_500);
    });
});

describe('the series anchor on coalesced rows', () => {
    const bounded: TopologyReplanTiming = {
        window: { debounceMs: DEBOUNCE_MS, maxWaitMs: 1_200 },
        replanNotBeforeEpochMs: null
    };

    function createReplan(requestedAtEpochMs: number, previousEntry: ResourceEntry | null) {
        return computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: GROUP_REF,
            groupSnapshot: createGroupSnapshot(4, previousEntry === null ? 3 : 4),
            requestedAtEpochMs,
            expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
            timing: bounded,
            senderId: 'server-1',
            origin: 'automatic',
            previousEntry
        });
    }

    it('keeps the first request of the series through every merge and bounds the due time by it', () => {
        const first = createReplan(BASE_EPOCH_MS, null);
        const second = createReplan(BASE_EPOCH_MS + 400, first.entryWrite.entry);
        const third = createReplan(BASE_EPOCH_MS + 900, second.entryWrite.entry);

        expect(readPersistedGroupRevisionEnvelope(third.entryWrite.entry).data[COALESCED_APP_OUTBOX_WORK_FIELD]).toMatchObject({
            generation: 3,
            windowOpenedAtEpochMs: BASE_EPOCH_MS,
            dueAtEpochMs: BASE_EPOCH_MS + 1_200
        });
    });

    it('restarts the series on the successor row minted behind a reserved head', () => {
        const first = createReplan(BASE_EPOCH_MS, null);
        const reserved = { ...first.entryWrite.entry, status: EntityStatus.RESERVED };
        const behind = createReplan(BASE_EPOCH_MS + 5_000, reserved);

        expect(readPersistedGroupRevisionEnvelope(behind.successorWrite.entry).data[COALESCED_APP_OUTBOX_WORK_FIELD])
            .toMatchObject({ generation: 1, windowOpenedAtEpochMs: BASE_EPOCH_MS + 5_000 });
    });

    it('fails closed on a predecessor without a series anchor', () => {
        const first = createReplan(BASE_EPOCH_MS, null);
        const message = JSON.parse(first.entryWrite.entry.resource);
        const envelope = JSON.parse(message.payload.resource);
        delete envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD].windowOpenedAtEpochMs;
        const malformedPredecessor = {
            ...first.entryWrite.entry,
            resource: JSON.stringify({ ...message, payload: { ...message.payload, resource: JSON.stringify(envelope) } })
        };

        expect(() => createReplan(BASE_EPOCH_MS + 400, malformedPredecessor)).toThrow(/not coalesced topology work/);
    });

    it('keeps a head that already failed an attempt retryable when the bound makes a merge due at once', () => {
        const first = createReplan(BASE_EPOCH_MS, null);
        const failedOnce = {
            ...first.entryWrite.entry,
            status: EntityStatus.RETRY,
            dequeueAudit: { ...first.entryWrite.entry.dequeueAudit, attempts: 1 }
        };

        const merged = createReplan(BASE_EPOCH_MS + 1_300, failedOnce);

        expect(merged.entryWrite.entry.status).toBe(EntityStatus.RETRY);
        expect(merged.entryWrite.entry.dequeueAudit.attempts).toBe(1);
        expect(merged.entryWrite.entry.dequeueAudit.nextTs?.epochMilliseconds).toBe(BASE_EPOCH_MS + 1_200);
    });
});
