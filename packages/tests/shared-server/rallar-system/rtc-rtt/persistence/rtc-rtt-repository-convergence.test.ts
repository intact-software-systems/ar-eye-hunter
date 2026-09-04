import { hashMutationCommand, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { RtcRttMutationCommand } from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-contracts.ts';
import { toRtcRttMutationReceiptId, toRtcRttTopologyOutboxId } from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-identifiers.ts';
import { RTC_RTT_MUTATION_RETENTION_MS } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-persistence-validation-primitives.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import {
    RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
    RTC_RTT_RECEIPTS_NAMESPACE
} from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-runtime-namespaces.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { describe, expect, it, vi } from 'vitest';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    createRttGroupSnapshot,
    executeRtcRttMutation
} from './rtc-rtt-persistence-test-fixtures.ts';

describe('RTC RTT repository convergence', () => {
    it('optimistically admits only one of two endpoint-cap races', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => 1
        });
        let waiting = 0;
        const together = Promise.withResolvers<void>();
        const originalList = repository.listMeasurementEntries.bind(repository);
        vi.spyOn(repository, 'listMeasurementEntries').mockImplementation(async () => {
            const values = await originalList();
            waiting += 1;
            if (waiting === 2) {
                together.resolve();
            }
            await together.promise;
            return values;
        });
        const groupAB = createRttGroupSnapshot('room-ab', ['session-a', 'session-b']);
        const groupAC = createRttGroupSnapshot('room-ac', ['session-a', 'session-c']);
        const commands: readonly RtcRttMutationCommand[] = [
            {
                rtt: {
                    sessionIdFrom: 'session-a',
                    sessionIdTo: 'session-b',
                    rttMs: 1,
                    createdAtEpochMs: 1,
                    version: 1
                },
                alSenderId: 'session-a',
                candidateGroups: [groupAB],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1
            },
            {
                rtt: {
                    sessionIdFrom: 'session-a',
                    sessionIdTo: 'session-c',
                    rttMs: 2,
                    createdAtEpochMs: 1,
                    version: 1
                },
                alSenderId: 'session-a',
                candidateGroups: [groupAC],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1
            }
        ];
        const execute = (command: RtcRttMutationCommand, attemptCount: number) =>
            executeRtcRttMutation({
                repository,
                runtime: runtimeRepository,
                command,
                readFacts: () => ({
                    purgeAfterEpochMs: 60_001,
                    requestedAtEpochMs: 1
                }),
                attemptCount
            });

        const firstAttempts = await Promise.allSettled([
            execute(commands[0]!, 1),
            execute(commands[1]!, 1)
        ]);
        const conflictIndex = firstAttempts.findIndex((result) => result.status === 'rejected');
        expect(firstAttempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(firstAttempts[conflictIndex]).toMatchObject({
            status: 'rejected',
            reason: expect.any(RuntimeStateWriteConflictError)
        });
        const conflictCommand = commands[conflictIndex];
        if (!conflictCommand) {
            throw new Error('Expected one conflicted RTT delivery');
        }

        await expect(execute(conflictCommand, 2)).resolves.toMatchObject({
            updated: false,
            computed: { outcome: 'rejected', reason: 'over-degree' }
        });
        expect(await repository.listMeasurements()).toHaveLength(1);
    });

    it.each(['group', 'session-from', 'session-to'] as const)(
        'rejects RTT authority when the candidate %s is expired at attempt time',
        async (expiredAuthority) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcRttRepository(runtimeRepository, {
                now: () => 10
            });
            const baseGroup = createRttGroupSnapshot(`room-expired-${expiredAuthority}`, [
                'session-a',
                'session-b'
            ]);
            const group = expiredAuthority === 'group'
                ? {
                    ...baseGroup,
                    group: { ...baseGroup.group, expiresAtEpochMs: 10 }
                }
                : {
                    ...baseGroup,
                    activeSessions: baseGroup.activeSessions.map((session) =>
                        session.sessionId ===
                                (expiredAuthority === 'session-from' ? 'session-a' : 'session-b')
                            ? { ...session, expiresAtEpochMs: 10 }
                            : session
                    )
                };
            const command: RtcRttMutationCommand = {
                rtt: {
                    sessionIdFrom: 'session-a',
                    sessionIdTo: 'session-b',
                    rttMs: 1,
                    createdAtEpochMs: 1,
                    version: 1
                },
                alSenderId: 'session-a',
                candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1
            };

            await expect(
                executeRtcRttMutation({
                    repository,
                    runtime: runtimeRepository,
                    command,
                    readFacts: () => ({
                        requestedAtEpochMs: 10,
                        purgeAfterEpochMs: 60_010
                    }),
                    attemptCount: 1
                })
            ).resolves.toMatchObject({
                updated: false,
                computed: {
                    outcome: 'rejected',
                    reason: 'no-shared-active-group'
                }
            });
            await expect(runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE)).resolves.toEqual(
                []
            );
        }
    );

    it('reruns RTT lifecycle authority after a CAS conflict crosses group expiry', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => 1
        });
        const baseGroup = createRttGroupSnapshot('room-retry-expiry', ['session-a', 'session-b']);
        const group = {
            ...baseGroup,
            group: { ...baseGroup.group, expiresAtEpochMs: 2 }
        };
        const command: RtcRttMutationCommand = {
            rtt: {
                sessionIdFrom: 'session-a',
                sessionIdTo: 'session-b',
                rttMs: 1,
                createdAtEpochMs: 1,
                version: 1
            },
            alSenderId: 'session-a',
            candidateGroups: [group],
            overlaySnapshotsByGroupKey: new Map(),
            degreeLimit: 1
        };
        const lifecycleFacts = [
            {
                requestedAtEpochMs: 1,
                purgeAfterEpochMs: 60_001
            },
            {
                requestedAtEpochMs: 2,
                purgeAfterEpochMs: 60_002
            }
        ];
        const readCommand = () => command;
        const readFacts = () => {
            const facts = lifecycleFacts.shift();
            if (facts === undefined) {
                throw new Error('RTT lifecycle facts exhausted');
            }
            return facts;
        };
        let forcedConflict = false;
        runtimeRepository.beforeConditionalWrite = async (operation, namespace, key) => {
            if (
                !forcedConflict &&
                operation === 'insertIfAbsent' &&
                namespace === RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE
            ) {
                forcedConflict = true;
                const endpointId = decodeURIComponent(key.slice('endpoint='.length));
                const peerSessionId = endpointId === 'session-a' ? 'session-b' : 'session-a';
                await runtimeRepository.upsert(
                    namespace,
                    key,
                    JSON.stringify({
                        endpointId,
                        peers: [{ peerSessionId, expiresAtEpochMs: 60_001 }],
                        version: 1,
                        updatedAtEpochMs: 1
                    }),
                    60_001
                );
            }
        };

        const execute = (attemptCount: number) =>
            executeRtcRttMutation({
                repository,
                runtime: runtimeRepository,
                command,
                readCommand,
                readFacts,
                attemptCount
            });

        await expect(execute(1)).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        await expect(execute(2)).resolves.toMatchObject({
            updated: false,
            computed: {
                outcome: 'rejected',
                reason: 'no-shared-active-group'
            }
        });
        expect(lifecycleFacts).toEqual([]);
        await expect(runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE)).resolves.toEqual([]);
    });

    it.each(
        (['duplicate', 'out-of-order'] as const).flatMap((defect) =>
            (['direct', 'list', 'page'] as const).map((surface) => ({
                defect,
                surface
            }))
        )
    )(
        'rejects $defect affected group refs on receipt $surface reads',
        async ({ defect, surface }) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcRttRepository(runtimeRepository, {
                now: () => 1
            });
            const rtt = {
                sessionIdFrom: 'session-a',
                sessionIdTo: 'session-b',
                rttMs: 1,
                createdAtEpochMs: 1,
                version: 1
            };
            const receiptId = toRtcRttMutationReceiptId(rtt);
            const refA = { applicationId: 'app-1', groupId: 'room-a' };
            const refB = { applicationId: 'app-1', groupId: 'room-b' };
            await runtimeRepository.upsert(
                RTC_RTT_RECEIPTS_NAMESPACE,
                receiptId,
                JSON.stringify({
                    receiptId,
                    sessionIdFrom: rtt.sessionIdFrom,
                    sessionIdTo: rtt.sessionIdTo,
                    measurementVersion: rtt.version,
                    affectedGroupRefs: defect === 'duplicate' ? [refA, refA] : [refB, refA],
                    acceptedAtEpochMs: 1,
                    outcome: 'accepted',
                    commandHash: `sha256:${'a'.repeat(64)}`
                }),
                86_400_001
            );

            const read = surface === 'direct'
                ? repository.findMutationReceiptEntry(receiptId)
                : surface === 'list'
                ? repository.listMutationReceiptEntries()
                : repository.listMutationReceiptEntriesPage({
                    limit: 10
                });
            await expect(read).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption'
            });
        }
    );

    it.each([
        { name: 'exact replay', divergent: false },
        { name: 'divergent reuse', divergent: true }
    ])(
        'resolves $name from retained raw receipt authority without clocks or effects',
        async ({ divergent }) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const baseRtt = {
                sessionIdFrom: 'session-a',
                sessionIdTo: 'session-b',
                rttMs: 1,
                createdAtEpochMs: 1,
                version: 1
            };
            const receiptId = toRtcRttMutationReceiptId(baseRtt);
            const commandHash = await hashMutationCommand({
                rtt: baseRtt,
                alSenderId: 'session-a'
            } as JsonWireValue);
            const affectedGroupRef = {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-retained-replay'
            };
            await runtimeRepository.insertIfAbsent(
                RTC_RTT_RECEIPTS_NAMESPACE,
                receiptId,
                JSON.stringify({
                    receiptId,
                    commandId: receiptId,
                    requestId: receiptId,
                    sessionIdFrom: baseRtt.sessionIdFrom,
                    sessionIdTo: baseRtt.sessionIdTo,
                    aggregateRef: {
                        sessionIdFrom: baseRtt.sessionIdFrom,
                        sessionIdTo: baseRtt.sessionIdTo
                    },
                    measurementVersion: baseRtt.version,
                    affectedGroupRefs: [affectedGroupRef],
                    acceptedAtEpochMs: 1,
                    outcome: 'accepted',
                    attemptCount: 1,
                    acceptedStorageRevision: 0,
                    eventId: null,
                    outboxIds: [toRtcRttTopologyOutboxId(receiptId, affectedGroupRef, commandHash)],
                    commandHash
                }),
                1 + RTC_RTT_MUTATION_RETENTION_MS
            );
            const now = () => {
                throw new Error('RTT receipt replay clock');
            };
            const repository = new RtcRttRepository(runtimeRepository, { now });
            const policy = () => {
                throw new Error('RTT receipt replay policy');
            };
            const lifecycle = () => {
                throw new Error('RTT receipt replay lifecycle');
            };
            vi.spyOn(repository, 'findMeasurementEntry')
                .mockRejectedValue(new Error('RTT receipt replay measurement'));
            vi.spyOn(repository, 'listMeasurementEntries')
                .mockRejectedValue(new Error('RTT receipt replay measurement list'));
            vi.spyOn(repository, 'findEndpointAdmissionEntry')
                .mockRejectedValue(new Error('RTT receipt replay admission'));
            vi.spyOn(runtimeRepository, 'deleteIfRevision')
                .mockRejectedValue(new Error('RTT receipt replay cleanup'));
            vi.spyOn(runtimeRepository, 'begin')
                .mockRejectedValue(new Error('RTT receipt replay transaction'));
            const request = {
                rtt: divergent ? { ...baseRtt, rttMs: 2 } : baseRtt,
                alSenderId: 'session-a'
            };
            const executed = executeRtcRttMutation({
                repository,
                runtime: runtimeRepository,
                command: {
                    ...request,
                    candidateGroups: null,
                    overlaySnapshotsByGroupKey: null,
                    degreeLimit: null
                },
                readCommand: policy,
                readFacts: lifecycle,
                attemptCount: 1
            });

            if (divergent) {
                await expect(executed).rejects.toMatchObject({
                    code: 'rtc-rtt-idempotency-conflict'
                });
            }
            else {
                await expect(executed).resolves.toMatchObject({
                    updated: false,
                    computed: { outcome: 'replay', reason: 'accepted' }
                });
            }
        }
    );
});
