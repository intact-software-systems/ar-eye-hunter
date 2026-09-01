import { Temporal } from '@js-temporal/polyfill';
import { parseTemporalPlainDateTime, toPgTimestamp } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import type {
    GroupMutationCommand,
    GroupMutationFacts,
    GroupMutationRead
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { groupStateMemberStorageKey } from '@shared-server/rallar-system/group-state/persistence/membership/group-membership-storage-key.ts';
import type { AuditStamp, Group, GroupMember, GroupRef } from '@shared/api/group-types.ts';
import { decodeCanonicalGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { describe, expect, it } from 'vitest';
import { createTestGroup } from '../../../../create-test-group.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { createService, seedOpenGroup } from './group-presence-test-runtime.ts';

const ref: GroupRef = {
    applicationId: 'cross-process-app',
    workspaceId: 'cross-process-workspace',
    groupId: 'cross-process-group'
};
const seedAudit: AuditStamp = {
    atEpochMs: 1_000,
    actor: { kind: 'principal', principalId: 'owner' },
    reason: null,
    traceId: null,
    requestId: 'seed'
};

describe('group presence-summary causal identity', () => {
    it('advances 100 independent heartbeats without acquiring the group guard', async () => {
        const baseEpochMs = Date.now();
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'heartbeat-room', 200);
        const service = createService(runtime, baseEpochMs + 2_000);
        for (let index = 0; index < 100; index += 1) {
            const principalId = `member-${index}`;
            await service.upsertMember(SCOPE, 'heartbeat-room', principalId, {
                status: 'active',
                actorPrincipalId: principalId,
                requestId: `member-${index}`
            });
            await service.connectPresenceSession(SCOPE, 'heartbeat-room', `session-${index}`, {
                principalId,
                generationId: `generation-${index}`,
                actorPrincipalId: `member-${index}`,
                expiresAtEpochMs: baseEpochMs + 50_000,
                requestId: `connect-${index}`
            });
        }
        runtime.resetGuards();
        await Promise.all(
            Array.from({ length: 100 }, (_, index) =>
                createService(runtime, baseEpochMs + 3_000 + index).heartbeatPresenceSessionReceipt(
                    SCOPE,
                    'heartbeat-room',
                    `session-${index}`,
                    {
                        generationId: `generation-${index}`,
                        actorPrincipalId: `member-${index}`,
                        lastHeartbeatAtEpochMs: baseEpochMs + 3_000 + index,
                        expiresAtEpochMs: baseEpochMs + 60_000 + index,
                        requestId: `heartbeat-${index}`
                    }
                ))
        );
        expect(runtime.groupGuards).toBe(0);
        expect(runtime.presenceGuards).toBe(100);
        expect(runtime.hotPathListReads).toBe(0);
        expect(runtime.snapshotListReads).toBe(0);

        await createService(runtime, baseEpochMs + 4_000).heartbeatPresenceSession(
            SCOPE,
            'heartbeat-room',
            'session-0',
            {
                generationId: 'generation-0',
                actorPrincipalId: 'member-0',
                lastHeartbeatAtEpochMs: baseEpochMs + 4_000,
                expiresAtEpochMs: baseEpochMs + 70_000,
                requestId: 'snapshot-heartbeat'
            }
        );
        expect(runtime.snapshotListReads).toBeGreaterThan(0);
    });

    it('preserves UTC wall-clock fields returned as Date values by postgres', () => {
        const previousTimezone = process.env.TZ;
        process.env.TZ = 'Asia/Tokyo';
        try {
            const canonical = Temporal.PlainDateTime.from('2026-07-26T18:01:26.954');
            expect(toPgTimestamp(canonical)).toBe('2026-07-26T18:01:26.954Z');
            expect(parseTemporalPlainDateTime(new Date('2026-07-26T09:01:26.954Z')).toString()).toBe(
                canonical.toString()
            );
        }
        finally {
            process.env.TZ = previousTimezone;
        }
    });

    it('uses the snapshot version when another process advanced storage revision', () => {
        const command: GroupMutationCommand = {
            operation: 'upsertMember',
            aggregateRef: ref,
            targetPrincipalId: 'member',
            commandId: 'cross-process-member',
            requestId: 'cross-process-member',
            input: {
                role: null,
                status: 'active',
                invitedByPrincipalId: null,
                invitationExpiresAtEpochMs: null,
                actorPrincipalId: 'member',
                actorSessionId: 'member-session',
                reason: null,
                traceId: null
            }
        };
        const computed = computeGroupMutation({
            command,
            read: mutationRead(40),
            facts: mutationFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            throw new Error('Expected a durable group write');
        }
        expect(computed.receipt.causalRevision).toEqual({ groupRevision: 2, presenceRevision: 0 });
        expect(computed.receipt.snapshotVersion).toBe(2);
        const effect = decodeCanonicalGroupPresenceSummaryEntry(computed.outboxEntries[0]);
        expect(effect.acceptedCausalRevision).toEqual(computed.receipt.causalRevision);
        expect(effect.event.snapshotVersion).toBe(computed.receipt.snapshotVersion);
    });
});

function mutationRead(storageRevision: number): GroupMutationRead {
    const group: Group = createTestGroup({
        ...ref,
        displayName: 'Cross-process group',
        maxMembers: 100,
        maxSessionsPerMember: 4,
        activeMemberCount: 1,
        ownerPrincipalId: 'owner',
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 0,
        created: seedAudit,
        updated: seedAudit
    });
    const owner = member('owner', 'owner');
    return {
        idempotency: null,
        group: stored(groupStateGroupStorageKey(ref), group, storageRevision),
        expiredGroupEntry: null,
        actorMember: null,
        targetMember: null,
        authorityMember: owner,
        directorMember: null,
        actorMemberEntry: null,
        targetMemberEntry: null,
        authorityMemberEntry: stored(
            groupStateMemberStorageKey({ ...ref, principalId: owner.principalId }),
            owner,
            0
        ),
        directorMemberEntry: null,
        targetPresence: null,
        expiredTargetPresenceEntry: null,
        targetAdmission: null,
        authorityAdmission: null,
        directorAdmission: null,
        authorityPresenceSessions: [],
        authorityPresenceSessionEntries: [],
        presenceSummary: null,
        // upsertMember consults the admission policy; absent means open admission.
        lifecyclePolicy: { status: 'absent' },
        activeMemberPrincipalIds: null,
        plannedLayoutRow: null,
        connectTriggerLatch: null,
        acceptedLayoutRow: null
    } as GroupMutationRead;
}

function member(principalId: string, role: GroupMember['role']): GroupMember {
    return {
        ...ref,
        principalId,
        role,
        status: 'active',
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        joined: seedAudit,
        updated: seedAudit,
        left: null,
        removed: null,
        banned: null
    };
}

function stored<T>(key: string, value: T, revision: number) {
    return {
        entry: {
            key,
            value: JSON.stringify(value),
            expireAtTimestamp: Number.MAX_SAFE_INTEGER,
            updatedTimestamp: new Date(0).toISOString(),
            revision
        },
        value
    };
}

function mutationFacts(): GroupMutationFacts {
    return {
        nowEpochMs: 2_000,
        expireAtEpochMs: 253_402_300_799_999,
        serviceId: 'consumer-service',
        eventId: 'cross-process-event',
        commandHash: `sha256:${'a'.repeat(64)}`,
        attemptCount: 1,
        resolvedJoinCode: null,
        joinCodeVerifier: null,
        internalAuthority: 'none',
        authenticatedAuthority: {
            principalId: 'member',
            sessionId: 'member-session'
        }
    };
}
