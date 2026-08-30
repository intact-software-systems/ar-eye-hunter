import { describe, expect, it } from 'vitest';

import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import { GroupMutationAuthorizationError } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { RtcRttInboxService } from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-inbox-service.ts';
import { toRtcRttMutationReceiptId } from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-identifiers.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import { readRtcTopologyWorkEnvelope } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-codec.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { AuditStamp, GroupMember, GroupPresenceSession, GroupSnapshot } from '@shared/api/group-types.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { createTestGroup } from '../../../create-test-group.ts';
import { createAuthorityHarness, createResilience, SCOPE, type AuthorityHarness } from '../group-state/inbox/group-state-inbox-test-runtime.ts';

describe('durable RTC RTT refinement work', () => {
    it('preserves the accepted RTT observation in final topology work', async () => {
        const harness = await createAuthorityHarness(['alice', 'bob']);
        const rtt = {
            sessionIdFrom: 'alice-session',
            sessionIdTo: 'bob-session',
            rttMs: 12,
            createdAtEpochMs: harness.nowEpochMs,
            version: 1
        };
        const service = createRttService(harness);

        await service.enqueue({
            rtt,
            alSenderId: rtt.sessionIdFrom,
            capturedAtEpochMs: harness.nowEpochMs
        });
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        expect(harness.database.outboxEntries.size).toBe(1);
        const entry = [...harness.database.outboxEntries.values()][0];
        if (!entry) {
            throw new Error('Expected durable RTC topology work');
        }
        const message = decodePersistedALMessage(entry.resource);
        const envelope = readRtcTopologyWorkEnvelope(message, AppOutboxType.RTC_TOPOLOGY_RECOMPUTE);
        expect(envelope.data).toMatchObject({
            kind: 'rtt-refresh',
            rtt,
            refinementObservationId: toRtcRttMutationReceiptId(rtt)
        });
    });

    it.each([
        { rejectedFrom: 'bob-session', first: 'rejected' },
        { rejectedFrom: 'bob-session', first: 'canonical' },
        { rejectedFrom: 'alice-session', first: 'rejected' },
        { rejectedFrom: 'alice-session', first: 'canonical' }
    ])('keeps the pair/version slot available when $rejectedFrom reports as bob, $first first', async ({ rejectedFrom, first }) => {
        const harness = await createAuthorityHarness(['alice', 'bob']);
        const service = createRttService(harness);
        const canonical = {
            rtt: {
                sessionIdFrom: 'alice-session',
                sessionIdTo: 'bob-session',
                rttMs: 12,
                createdAtEpochMs: harness.nowEpochMs,
                version: 1
            },
            alSenderId: 'alice-session',
            capturedAtEpochMs: harness.nowEpochMs
        };
        const rejected = {
            ...canonical,
            alSenderId: 'bob-session',
            rtt: {
                ...canonical.rtt,
                sessionIdFrom: rejectedFrom,
                sessionIdTo: rejectedFrom === 'bob-session' ? 'alice-session' : 'bob-session'
            }
        };
        if (first === 'canonical') {
            await service.enqueue(canonical);
        }
        const before = await harness.queueEntries();

        await expect(service.enqueue(rejected)).rejects.toBeInstanceOf(GroupMutationAuthorizationError);
        expect(await harness.queueEntries()).toEqual(before);
        await service.enqueue(canonical);
        await service.enqueue(canonical);
        expect(await harness.queueEntries()).toHaveLength(1);

        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        expect(harness.database.outboxEntries.size).toBe(1);
        const entry = [...harness.database.outboxEntries.values()][0];
        if (!entry) {
            throw new Error('Expected accepted canonical RTT topology work');
        }
        const envelope = readRtcTopologyWorkEnvelope(
            decodePersistedALMessage(entry.resource),
            AppOutboxType.RTC_TOPOLOGY_RECOMPUTE
        );
        expect(envelope.data).toMatchObject({ kind: 'rtt-refresh', rtt: canonical.rtt });
    });
});

function createRttService(harness: AuthorityHarness): RtcRttInboxService {
    const group = createRttGroupSnapshot(harness.nowEpochMs);
    return new RtcRttInboxService(
        {
            inboxQueueReader: harness.reader,
            resourceInboxRepository: harness.queue,
            resourceInboxResultsRepository: harness.results,
            database: harness.database,
            groupStateService: harness.groupStateService,
            mutationDependencies: {
                repository: new RtcRttRepository(harness.runtimeRepository, { now: () => harness.nowEpochMs }),
                outboxWriter: new RtcTopologyOutboxWriter({ recordWrite: () => undefined }),
                readPolicyInputs: async () => ({
                    candidateGroups: [group],
                    overlaySnapshotsByGroupKey: new Map(),
                    degreeLimit: 2
                })
            }
        },
        { serviceId: 'rtc-rtt-app-inbox-test', options: { nowEpochMs: () => harness.nowEpochMs } }
    );
}

function createRttGroupSnapshot(nowEpochMs: number): GroupSnapshot {
    const groupRef = { ...SCOPE, groupId: 'rtc-room' };
    const audit: AuditStamp = {
        atEpochMs: nowEpochMs,
        actor: { kind: 'principal', principalId: 'alice' },
        reason: null,
        traceId: null,
        requestId: null
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
        updated: audit
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
        disconnectReason: null
    }));
    return {
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        group: createTestGroup({
            ...groupRef,
            displayName: 'RTC room',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            activeMemberCount: 2,
            ownerPrincipalId: 'alice',
            created: audit,
            updated: audit
        }),
        members,
        activeSessions,
        memberCount: 2,
        onlineMemberCount: 2
    };
}
