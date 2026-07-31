import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AuditStamp, Group } from '@shared/api/group-types.ts';
import { createTransactionBoundGroupStateRepository, GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { type GroupMutationIdempotencyRecord, type GroupMutationRead } from '@shared-server/rallar-system/services/group-state-mutations.ts';
import { groupStateGroupStorageKey, groupStateIdempotencyStorageKey } from '@shared-server/rallar-system/group-state/persistence/group-state-storage-keys.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { groupMemberStorageKey, groupRef, groupStorageKey, storedEntry } from '../mutation/group-mutation-test-runtime.ts';

describe('GroupStateRepository persistence', () => {
    it('constructs the public facade for transaction-bound persistence', () => {
        const transaction = (() => undefined) as unknown as
            Parameters<typeof createTransactionBoundGroupStateRepository>[0];
        expect(createTransactionBoundGroupStateRepository(transaction))
            .toBeInstanceOf(GroupStateRepository);
    });
    it('keeps absent and explicit sentinel workspaces isolated at the repository boundary', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new GroupStateRepository(runtime);
        const base = createMutationRead().group!.value;
        const absentGroup: Group = {
            ...base,
            applicationId: 'boundary-app',
            workspaceId: 'workspace-default',
            groupId: 'boundary-group',
            slug: 'absent-workspace',
            displayName: 'Absent workspace',
        };
        const explicitSentinelGroup: Group = {
            ...absentGroup,
            workspaceId: '_',
            slug: 'explicit-sentinel-workspace',
            displayName: 'Explicit sentinel workspace',
        };

        await repository.putGroup(absentGroup);
        await repository.putGroup(explicitSentinelGroup);

        expect(await repository.findGroup(absentGroup)).toEqual(absentGroup);
        expect(await repository.findGroup(explicitSentinelGroup))
            .toEqual(explicitSentinelGroup);
        expect(await repository.listGroups({
            applicationId: 'boundary-app',
            workspaceId: 'workspace-default',
        }))
            .toEqual([absentGroup]);
        expect(await repository.listGroups({
            applicationId: 'boundary-app',
            workspaceId: '_',
        })).toEqual([explicitSentinelGroup]);
    });
    it('fails closed when an absent-scope direct read decodes a legacy explicit-sentinel group', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new GroupStateRepository(runtime);
        const absentRef = {
            applicationId: 'legacy-boundary-app',
            workspaceId: 'legacy-workspace',
            groupId: 'legacy-boundary-group',
        };
        const explicitSentinelGroup: Group = {
            ...createMutationRead().group!.value,
            ...absentRef,
            workspaceId: '_',
            activeMemberCount: 0,
        };

        await runtime.upsert(
            'group-state:groups',
            groupStateGroupStorageKey(absentRef),
            JSON.stringify(explicitSentinelGroup),
            Number.MAX_SAFE_INTEGER,
        );

        await expect(repository.findGroup(absentRef)).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption',
        });
        await expect(repository.readSnapshot(absentRef)).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption',
        });
    });
    it('fails closed when a direct repository result carries a noncanonical physical key', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const ref = {
            applicationId: 'physical-key-app',
            workspaceId: 'physical-key-workspace',
            groupId: 'physical-key-group',
        };
        const group: Group = {
            ...createMutationRead().group!.value,
            ...ref,
        };
        vi.spyOn(runtime, 'findEntry').mockResolvedValue({
            key: 'app=other:ws=_:group=other',
            value: JSON.stringify(group),
            expireAtTimestamp: Number.MAX_SAFE_INTEGER,
            updatedTimestamp: new Date().toISOString(),
            revision: 0,
        });
        await expect(new GroupStateRepository(runtime).findGroup(ref))
            .rejects.toMatchObject({
                code: 'group-state-repository-invariant-corruption',
                message:
                    'Stored group key differs from the requested scope:' +
                    ' app=other:ws=_:group=other',
            });
    });
    it('enforces the exact compact idempotency contract on insert and both read APIs', async () => {
        const ref = {
            applicationId: 'exact-receipt-app',
            workspaceId: 'exact-receipt-workspace',
            groupId: 'exact-receipt-group',
        };
        const requestId = 'exact-request';
        const commandHash = `sha256:${'2'.repeat(64)}`;
        const valid: GroupMutationIdempotencyRecord = {
            aggregateRef: ref,
            requestId,
            commandHash,
            receipt: {
                commandId: requestId,
                requestId,
                commandHash,
                aggregateRef: ref,
                outcome: 'no-op',
                attemptCount: 1,
                acceptedStorageRevision: 0,
                stateRevision: 1,
                snapshotVersion: 1,
                causalRevision: { groupRevision: 1, presenceRevision: 0 },
                eventId: null,
                outboxIds: [],
                joinCode: null,
                joinCodeExpiresAtEpochMs: null,
                rejection: null,
            },
        };
        const { commandHash: _missingCommandHash, ...missingCommandHash } = valid;
        const { aggregateRef: _legacyAggregateRef, ...legacyIdentityFree } = valid;
        const invalidRecords: readonly [string, unknown][] = [
            ['malformed SHA', { ...valid, commandHash: 'sha256:not-a-digest' }],
            ['empty receipt', { ...valid, receipt: {} }],
            ['unexpected top-level field', { ...valid, unexpected: true }],
            ['unexpected aggregateRef field', {
                ...valid,
                aggregateRef: { ...ref, unexpected: true },
            }],
            ['missing required field', missingCommandHash],
            ['mismatched receipt/hash identity', {
                ...valid,
                receipt: {
                    ...valid.receipt,
                    commandHash: `sha256:${'3'.repeat(64)}`,
                },
            }],
            ['mismatched receipt/command identity', {
                ...valid,
                receipt: { ...valid.receipt, commandId: 'other-command' },
            }],
            ['mismatched derived state revision', {
                ...valid,
                receipt: { ...valid.receipt, stateRevision: 2 },
            }],
            ['applied receipt without an accepted storage revision', {
                ...valid,
                receipt: {
                    ...valid.receipt,
                    outcome: 'applied',
                    acceptedStorageRevision: null,
                    eventId: 'event-1',
                    outboxIds: ['outbox-1'],
                },
            }],
            ['applied receipt without its authoritative outbox effect', {
                ...valid,
                receipt: {
                    ...valid.receipt,
                    outcome: 'applied',
                    eventId: 'event-1',
                },
            }],
            ['applied receipt without an authoritative snapshot version', {
                ...valid,
                receipt: {
                    ...valid.receipt,
                    outcome: 'applied',
                    snapshotVersion: 0,
                    eventId: 'event-1',
                    outboxIds: ['outbox-1'],
                },
            }],
            ['applied receipt without an authoritative event', {
                ...valid,
                receipt: { ...valid.receipt, outcome: 'applied' },
            }],
            ['no-op receipt without its accepted predecessor revision', {
                ...valid,
                receipt: { ...valid.receipt, acceptedStorageRevision: null },
            }],
            ['no-op receipt with a divergent predecessor revision', {
                ...valid,
                receipt: { ...valid.receipt, acceptedStorageRevision: 1 },
            }],
            ['no-op receipt with an unexpected outbox effect', {
                ...valid,
                receipt: { ...valid.receipt, outboxIds: ['outbox-1'] },
            }],
            ['no-op receipt without an authoritative snapshot version', {
                ...valid,
                receipt: { ...valid.receipt, snapshotVersion: 0 },
            }],
            ['no-op receipt with unexpected join-code materialization', {
                ...valid,
                receipt: {
                    ...valid.receipt,
                    joinCode: 'join-code',
                    joinCodeExpiresAtEpochMs: 2_000,
                },
            }],
            ['rejected receipt without its accepted predecessor revision', {
                ...valid,
                receipt: {
                    ...valid.receipt,
                    outcome: 'rejected',
                    acceptedStorageRevision: null,
                    rejection: 'rejected',
                },
            }],
            ['rejected receipt with a divergent predecessor revision', {
                ...valid,
                receipt: {
                    ...valid.receipt,
                    outcome: 'rejected',
                    acceptedStorageRevision: 1,
                    rejection: 'rejected',
                },
            }],
            ['rejected receipt with an unexpected outbox effect', {
                ...valid,
                receipt: {
                    ...valid.receipt,
                    outcome: 'rejected',
                    outboxIds: ['outbox-1'],
                    rejection: 'rejected',
                },
            }],
            ['rejected receipt with unexpected join-code materialization', {
                ...valid,
                receipt: {
                    ...valid.receipt,
                    outcome: 'rejected',
                    joinCode: 'join-code',
                    joinCodeExpiresAtEpochMs: 2_000,
                    rejection: 'rejected',
                },
            }],
            ['absent-group rejection with nonzero authority', {
                ...valid,
                receipt: {
                    ...valid.receipt,
                    outcome: 'rejected',
                    acceptedStorageRevision: null,
                    stateRevision: 1,
                    snapshotVersion: 0,
                    causalRevision: { groupRevision: 0, presenceRevision: 1 },
                    rejection: 'rejected',
                },
            }],
            ['legacy identity-free no-event record', legacyIdentityFree],
        ];

        const validRuntime = new FakeRuntimeStateRepository();
        const validRepository = new GroupStateRepository(validRuntime);
        await expect(validRepository.insertIdempotentGroupMutationReceipt(
            ref,
            requestId,
            valid,
        )).resolves.toMatchObject({ status: 'applied', revision: 0 });
        await expect(validRepository.findIdempotentGroupMutationReceipt(
            ref,
            requestId,
        )).resolves.toEqual(valid);

        const absentRequestId = 'absent-group-rejected-request';
        const absentRejected: GroupMutationIdempotencyRecord = {
            ...valid,
            requestId: absentRequestId,
            receipt: {
                ...valid.receipt,
                commandId: absentRequestId,
                requestId: absentRequestId,
                outcome: 'rejected',
                acceptedStorageRevision: null,
                stateRevision: 0,
                snapshotVersion: 0,
                causalRevision: { groupRevision: 0, presenceRevision: 0 },
                rejection: 'Group creation rejected',
            },
        };
        await expect(validRepository.insertIdempotentGroupMutationReceipt(
            ref,
            absentRequestId,
            absentRejected,
        )).resolves.toMatchObject({ status: 'applied', revision: 0 });
        await expect(validRepository.findIdempotentGroupMutationReceipt(
            ref,
            absentRequestId,
        )).resolves.toEqual(absentRejected);

        for (const [label, invalid] of invalidRecords) {
            const insertRepository = new GroupStateRepository(
                new FakeRuntimeStateRepository(),
            );
            await expect(insertRepository.insertIdempotentGroupMutationReceipt(
                ref,
                requestId,
                invalid as GroupMutationIdempotencyRecord,
            ), label).rejects.toMatchObject({
                code: 'group-state-repository-invariant-corruption',
            });

            const readRuntime = new FakeRuntimeStateRepository();
            await readRuntime.upsert(
                'group-state:idempotent',
                groupStateIdempotencyStorageKey(ref, requestId),
                JSON.stringify(invalid),
                Number.MAX_SAFE_INTEGER,
            );
            const readRepository = new GroupStateRepository(readRuntime);
            for (const read of [
                () => readRepository.findIdempotentGroupMutationReceipt(ref, requestId),
                () => readRepository.findIdempotentGroupMutationReceiptEntry(ref, requestId),
            ]) {
                await expect(read(), label).rejects.toMatchObject({
                    code: 'group-state-repository-invariant-corruption',
                });
            }
        }
    });
    it('keeps the approved persistence owners behind one public compatibility hop', () => {
        const root = 'packages/shared-server/rallar-system/group-state/persistence';
        for (const [file, symbol] of [
            ['group-state-repository.ts', 'GroupStateRepository'],
            ['group-state-repository-reads.ts', 'GroupStateRepositoryReads'],
            ['group-aggregate-repository.ts', 'GroupAggregateRepository'],
            ['group-membership-repository.ts', 'GroupMembershipRepository'],
            ['group-presence-repository.ts', 'GroupPresenceRepository'],
            ['group-state-snapshot-repository.ts', 'GroupStateSnapshotRepository'],
        ]) {
            expect(readFileSync(`${root}/${file}`, 'utf8')).toContain(`class ${symbol}`);
        }
        const oldRoot = 'packages/shared-server/rallar-system/repositories';
        const compatibility = readFileSync(`${oldRoot}/GroupStateRepository.ts`, 'utf8');
        expect(compatibility).not.toContain('export *');
        expect(compatibility).toContain("../group-state/persistence/group-state-repository.ts");
        for (const oldFile of ['group-state-authority-batch-read.ts',
            'group-state-mutation-exact-read.ts', 'group-state-snapshot-assembly.ts']) {
            expect(existsSync(`${oldRoot}/${oldFile}`), oldFile).toBe(false);
        }
    });
});
function auditStamp(
  atEpochMs: number,
  principalId: string,
  requestId: string | null,
): AuditStamp {
  return { atEpochMs, actor: { kind: 'principal', principalId },
    reason: null, traceId: null, requestId };
}

function createMutationRead(): GroupMutationRead {
  const audit = auditStamp(1_000, 'alice', 'seed');
  const group = {
    ...groupRef('pure-room'),
    slug: null, displayName: 'Before', description: null,
    kind: 'room' as const, status: 'active' as const,
    archived: null, deleted: null, joinMode: 'open' as const,
    maxMembers: null, maxSessionsPerMember: null, metadata: {},
    activeMemberCount: 1, ownerPrincipalId: 'alice',
    snapshotVersion: 1, metadataVersion: 1, rosterVersion: 1, presenceVersion: 0,
    expiresAtEpochMs: null, emptySinceEpochMs: null, purgeAfterEpochMs: null,
    created: audit, updated: audit,
  };
  const actorMember = {
    ...groupRef('pure-room'),
    principalId: 'alice', role: 'owner' as const, status: 'active' as const,
    invitedByPrincipalId: null, invitationExpiresAtEpochMs: null,
    left: null, removed: null, banned: null, joined: audit, updated: audit,
  };
  return {
    idempotency: null, group: storedEntry(groupStorageKey(), group),
    expiredGroupEntry: null, actorMember, targetMember: null,
    authorityMember: null, directorMember: null,
    actorMemberEntry: storedEntry(groupMemberStorageKey('alice'), actorMember),
    targetMemberEntry: null, authorityMemberEntry: null, directorMemberEntry: null,
    targetPresence: null, expiredTargetPresenceEntry: null, targetAdmission: null,
    authorityAdmission: null, directorAdmission: null,
    authorityPresenceSessions: [], authorityPresenceSessionEntries: [],
    presenceSummary: null,
  } as GroupMutationRead;
}
