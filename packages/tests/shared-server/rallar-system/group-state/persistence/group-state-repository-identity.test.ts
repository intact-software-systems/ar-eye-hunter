import { type GroupMutationIdempotencyRecord, type GroupMutationRead } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { groupStateIdempotencyStorageKey } from '@shared-server/rallar-system/group-state/persistence/idempotency/group-idempotency-storage-key.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { AuditStamp, Group } from '@shared/api/group-types.ts';
import { describe, expect, it, vi } from 'vitest';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { groupMemberStorageKey, groupRef, groupStorageKey, storedEntry } from '../mutation/group-mutation-test-runtime.ts';
import { createIdentityMutationRead } from './group-state-persistence-mutation-read-fixtures.ts';

describe('GroupStateRepository persistence', () => {
    it('keeps absent and explicit sentinel workspaces isolated at the repository boundary', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = createTestGroupStateRepository(runtime);
        const base = createIdentityMutationRead().group!.value;
        const absentGroup: Group = {
            ...base,
            applicationId: 'boundary-app',
            workspaceId: 'workspace-default',
            groupId: 'boundary-group',
            slug: 'absent-workspace',
            displayName: 'Absent workspace'
        };
        const explicitSentinelGroup: Group = {
            ...absentGroup,
            workspaceId: '_',
            slug: 'explicit-sentinel-workspace',
            displayName: 'Explicit sentinel workspace'
        };

        await repository.putGroup(absentGroup);
        await repository.putGroup(explicitSentinelGroup);

        expect(await repository.findGroup(absentGroup)).toEqual(absentGroup);
        expect(await repository.findGroup(explicitSentinelGroup)).toEqual(explicitSentinelGroup);
        expect(
            await repository.listGroups({
                applicationId: 'boundary-app',
                workspaceId: 'workspace-default'
            })
        ).toEqual([absentGroup]);
        expect(
            await repository.listGroups({
                applicationId: 'boundary-app',
                workspaceId: '_'
            })
        ).toEqual([explicitSentinelGroup]);
    });
    it('fails closed when an absent-scope direct read decodes an explicit-sentinel group', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = createTestGroupStateRepository(runtime);
        const absentRef = {
            applicationId: 'sentinel-boundary-app',
            workspaceId: 'sentinel-workspace',
            groupId: 'sentinel-boundary-group'
        };
        const explicitSentinelGroup: Group = {
            ...createIdentityMutationRead().group!.value,
            ...absentRef,
            workspaceId: '_',
            activeMemberCount: 0
        };

        await runtime.upsert(
            'group-state:groups',
            groupStateGroupStorageKey(absentRef),
            JSON.stringify(explicitSentinelGroup),
            Number.MAX_SAFE_INTEGER
        );

        await expect(repository.findGroup(absentRef)).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption'
        });
        await expect(repository.readSnapshot(absentRef)).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption'
        });
    });
    it('fails closed when a direct repository result carries a noncanonical physical key', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const ref = {
            applicationId: 'physical-key-app',
            workspaceId: 'physical-key-workspace',
            groupId: 'physical-key-group'
        };
        const group: Group = {
            ...createIdentityMutationRead().group!.value,
            ...ref
        };
        vi.spyOn(runtime, 'findEntry').mockResolvedValue({
            key: 'app=other:ws=_:group=other',
            value: JSON.stringify(group),
            expireAtTimestamp: Number.MAX_SAFE_INTEGER,
            updatedTimestamp: new Date().toISOString(),
            revision: 0
        });
        await expect(createTestGroupStateRepository(runtime).findGroup(ref)).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption',
            message: 'Stored group key differs from the requested scope:' + ' app=other:ws=_:group=other'
        });
    });
    it('enforces the exact compact idempotency contract on insert and both read APIs', async () => {
        const ref = {
            applicationId: 'exact-receipt-app',
            workspaceId: 'exact-receipt-workspace',
            groupId: 'exact-receipt-group'
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
                snapshotVersion: 1,
                causalRevision: { groupRevision: 1, presenceRevision: 0 },
                eventId: null,
                outboxIds: [],
                joinCode: null,
                joinCodeExpiresAtEpochMs: null,
                rejection: null
            }
        };
        const { commandHash: _missingCommandHash, ...missingCommandHash } = valid;
        const { aggregateRef: _aggregateRef, ...identityFree } = valid;
        const invalidRecords: readonly [string, JsonWireValue][] = [
            ['malformed SHA', { ...valid, commandHash: 'sha256:not-a-digest' }],
            ['empty receipt', { ...valid, receipt: {} }],
            ['unexpected top-level field', { ...valid, unexpected: true }],
            [
                'unexpected aggregateRef field',
                {
                    ...valid,
                    aggregateRef: { ...ref, unexpected: true }
                }
            ],
            ['missing required field', missingCommandHash],
            [
                'mismatched receipt/hash identity',
                {
                    ...valid,
                    receipt: {
                        ...valid.receipt,
                        commandHash: `sha256:${'3'.repeat(64)}`
                    }
                }
            ],
            [
                'mismatched receipt/command identity',
                {
                    ...valid,
                    receipt: { ...valid.receipt, commandId: 'other-command' }
                }
            ],
            [
                'unexpected scalar revision projection',
                {
                    ...valid,
                    receipt: { ...valid.receipt, stateRevision: 2 }
                }
            ],
            [
                'applied receipt without an accepted storage revision',
                {
                    ...valid,
                    receipt: {
                        ...valid.receipt,
                        outcome: 'applied',
                        acceptedStorageRevision: null,
                        eventId: 'event-1',
                        outboxIds: ['outbox-1']
                    }
                }
            ],
            [
                'applied receipt with more than one outbox effect',
                {
                    ...valid,
                    receipt: {
                        ...valid.receipt,
                        outcome: 'applied',
                        eventId: 'event-1',
                        outboxIds: ['outbox-1', 'outbox-2']
                    }
                }
            ],
            [
                'applied receipt without an authoritative snapshot version',
                {
                    ...valid,
                    receipt: {
                        ...valid.receipt,
                        outcome: 'applied',
                        snapshotVersion: 0,
                        eventId: 'event-1',
                        outboxIds: ['outbox-1']
                    }
                }
            ],
            [
                'applied receipt without an authoritative event',
                {
                    ...valid,
                    receipt: { ...valid.receipt, outcome: 'applied' }
                }
            ],
            [
                'no-op receipt without its accepted predecessor revision',
                {
                    ...valid,
                    receipt: { ...valid.receipt, acceptedStorageRevision: null }
                }
            ],
            [
                'no-op receipt with an unexpected outbox effect',
                {
                    ...valid,
                    receipt: { ...valid.receipt, outboxIds: ['outbox-1'] }
                }
            ],
            [
                'no-op receipt without an authoritative snapshot version',
                {
                    ...valid,
                    receipt: { ...valid.receipt, snapshotVersion: 0 }
                }
            ],
            [
                'no-op receipt with unexpected join-code materialization',
                {
                    ...valid,
                    receipt: {
                        ...valid.receipt,
                        joinCode: 'join-code',
                        joinCodeExpiresAtEpochMs: 2_000
                    }
                }
            ],
            [
                'rejected receipt without its accepted predecessor revision',
                {
                    ...valid,
                    receipt: {
                        ...valid.receipt,
                        outcome: 'rejected',
                        acceptedStorageRevision: null,
                        rejection: 'rejected'
                    }
                }
            ],
            [
                'rejected receipt with an unexpected outbox effect',
                {
                    ...valid,
                    receipt: {
                        ...valid.receipt,
                        outcome: 'rejected',
                        outboxIds: ['outbox-1'],
                        rejection: 'rejected'
                    }
                }
            ],
            [
                'rejected receipt with unexpected join-code materialization',
                {
                    ...valid,
                    receipt: {
                        ...valid.receipt,
                        outcome: 'rejected',
                        joinCode: 'join-code',
                        joinCodeExpiresAtEpochMs: 2_000,
                        rejection: 'rejected'
                    }
                }
            ],
            [
                'absent-group rejection with nonzero authority',
                {
                    ...valid,
                    receipt: {
                        ...valid.receipt,
                        outcome: 'rejected',
                        acceptedStorageRevision: null,
                        snapshotVersion: 0,
                        causalRevision: { groupRevision: 0, presenceRevision: 1 },
                        rejection: 'rejected'
                    }
                }
            ],
            ['identity-free no-event record', identityFree]
        ];

        const validRuntime = new FakeRuntimeStateRepository();
        const validRepository = createTestGroupStateRepository(validRuntime);
        await expect(
            validRepository.insertIdempotentGroupMutationReceipt(ref, requestId, valid)
        ).resolves.toMatchObject({ status: 'applied', revision: 0 });
        await expect(
            validRepository.findIdempotentGroupMutationReceipt(ref, requestId)
        ).resolves.toEqual(valid);

        const fencedRequestId = 'authority-fenced-no-op-request';
        const authorityFencedNoOp: GroupMutationIdempotencyRecord = {
            ...valid,
            requestId: fencedRequestId,
            receipt: {
                ...valid.receipt,
                commandId: fencedRequestId,
                requestId: fencedRequestId,
                acceptedStorageRevision: 7
            }
        };
        await expect(
            validRepository.insertIdempotentGroupMutationReceipt(
                ref,
                fencedRequestId,
                authorityFencedNoOp
            )
        ).resolves.toMatchObject({ status: 'applied', revision: 0 });
        await expect(
            validRepository.findIdempotentGroupMutationReceipt(ref, fencedRequestId)
        ).resolves.toEqual(authorityFencedNoOp);

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
                snapshotVersion: 0,
                causalRevision: { groupRevision: 0, presenceRevision: 0 },
                rejection: 'Group creation rejected'
            }
        };
        await expect(
            validRepository.insertIdempotentGroupMutationReceipt(ref, absentRequestId, absentRejected)
        ).resolves.toMatchObject({ status: 'applied', revision: 0 });
        await expect(
            validRepository.findIdempotentGroupMutationReceipt(ref, absentRequestId)
        ).resolves.toEqual(absentRejected);

        for (const [label, invalid] of invalidRecords) {
            const insertRepository = createTestGroupStateRepository(new FakeRuntimeStateRepository());
            await expect(
                insertRepository.insertIdempotentGroupMutationReceipt(
                    ref,
                    requestId,
                    invalid as GroupMutationIdempotencyRecord
                ),
                label
            ).rejects.toMatchObject({
                code: 'group-state-repository-invariant-corruption'
            });

            const readRuntime = new FakeRuntimeStateRepository();
            await readRuntime.upsert(
                'group-state:idempotent',
                groupStateIdempotencyStorageKey(ref, requestId),
                JSON.stringify(invalid),
                Number.MAX_SAFE_INTEGER
            );
            const readRepository = createTestGroupStateRepository(readRuntime);
            for (
                const read of [
                    () => readRepository.findIdempotentGroupMutationReceipt(ref, requestId),
                    () => readRepository.findIdempotentGroupMutationReceiptEntry(ref, requestId)
                ]
            ) {
                await expect(read(), label).rejects.toMatchObject({
                    code: 'group-state-repository-invariant-corruption'
                });
            }
        }
    });
});
