import { toRtcRttMutationReceiptId } from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-identifiers.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import { RTC_RTT_RECEIPTS_NAMESPACE } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-runtime-namespaces.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { describe, expect, it, vi } from 'vitest';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    createRttGroupSnapshot,
    executeRtcRttMutation
} from './rtc-rtt-persistence-test-fixtures.ts';

describe('RTC RTT receipt convergence', () => {
    it('replays an accepted RTT after measurement and admission expiry and rejects divergent reuse', async () => {
        let now = 1;
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, {
            ttlMs: 10,
            now: () => now
        });
        const group = createRttGroupSnapshot('room-replay', ['session-a', 'session-b']);
        const command = {
            rtt: {
                sessionIdFrom: 'session-a',
                sessionIdTo: 'session-b',
                rttMs: 1,
                createdAtEpochMs: 1,
                version: 1
            },
            alSenderId: 'session-a',
            candidateGroups: [group],
            overlaySnapshotsByGroupKey: new Map<string, RallarOverlayTopologySnapshot>(),
            degreeLimit: 1
        };
        let readFacts: () => ReturnType<RtcRttRepository['readMutationFacts']> = () => repository.readMutationFacts();
        const commandReader = {
            current: undefined as (() => typeof command) | undefined
        };
        const execute = (nextCommand = command) =>
            executeRtcRttMutation({
                repository,
                runtime: runtimeRepository,
                command: nextCommand,
                ...(commandReader.current ? { readCommand: commandReader.current } : {}),
                readFacts,
                attemptCount: 1
            });

        await expect(execute()).resolves.toMatchObject({
            updated: true,
            computed: { outcome: 'write' }
        });
        vi.spyOn(repository, 'findMeasurementEntry').mockRejectedValue(
            new Error('RTT receipt replay must not read measurements')
        );
        vi.spyOn(repository, 'listMeasurementEntries').mockRejectedValue(
            new Error('RTT receipt replay must not list measurements')
        );
        vi.spyOn(repository, 'findEndpointAdmissionEntry').mockRejectedValue(
            new Error('RTT receipt replay must not read endpoint admission')
        );
        vi.spyOn(runtimeRepository, 'deleteIfRevision').mockRejectedValue(
            new Error('RTT receipt replay must not delete state')
        );
        vi.spyOn(runtimeRepository, 'upsertIfRevision').mockRejectedValue(
            new Error('RTT receipt replay must not update state')
        );
        vi.spyOn(runtimeRepository, 'begin').mockRejectedValue(
            new Error('RTT receipt replay must not open a transaction')
        );
        vi.spyOn(runtimeRepository, 'insertIfAbsent').mockRejectedValue(
            new Error('RTT receipt replay must not insert state')
        );
        const policyReads = () => {
            throw new Error('RTT replay read policy authority');
        };
        const lifecycleReads = () => {
            throw new Error('RTT replay read lifecycle clock');
        };
        commandReader.current = policyReads;
        readFacts = lifecycleReads;
        now = 12;
        await expect(execute()).resolves.toMatchObject({
            updated: false,
            computed: { outcome: 'replay', reason: 'accepted' }
        });
        await expect(
            execute({
                ...command,
                rtt: { ...command.rtt, rttMs: 2 }
            })
        ).rejects.toMatchObject({ code: 'rtc-rtt-idempotency-conflict' });
        await expect(
            execute({
                ...command,
                alSenderId: 'session-b'
            })
        ).rejects.toMatchObject({ code: 'rtc-rtt-idempotency-conflict' });
        expect(await runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE)).toHaveLength(1);
    });

    it('converges concurrent identical RTT writers through the immutable receipt winner', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        runtimeRepository.serializeTransactions = true;
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => 1
        });
        const group = createRttGroupSnapshot('room-concurrent', ['session-a', 'session-b']);
        const command = {
            rtt: {
                sessionIdFrom: 'session-a',
                sessionIdTo: 'session-b',
                rttMs: 1,
                createdAtEpochMs: 1,
                version: 1
            },
            alSenderId: 'session-a',
            candidateGroups: [group],
            overlaySnapshotsByGroupKey: new Map<string, RallarOverlayTopologySnapshot>(),
            degreeLimit: 1
        };
        let waiting = 0;
        const together = Promise.withResolvers<void>();
        const originalList = repository.listMeasurementEntries.bind(repository);
        vi.spyOn(repository, 'listMeasurementEntries').mockImplementation(async () => {
            const values = await originalList();
            waiting += 1;
            if (waiting === 2) {
                together.resolve();
            }
            if (waiting <= 2) {
                await together.promise;
            }
            return values;
        });
        const execute = (attemptCount: number) =>
            executeRtcRttMutation({
                repository,
                runtime: runtimeRepository,
                command,
                readFacts: () => ({
                    requestedAtEpochMs: 1,
                    purgeAfterEpochMs: 60_001
                }),
                attemptCount
            });

        const firstAttempts = await Promise.allSettled([execute(1), execute(1)]);

        expect(firstAttempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(firstAttempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(firstAttempts).toContainEqual({
            status: 'rejected',
            reason: expect.any(RuntimeStateWriteConflictError)
        });
        await expect(execute(2)).resolves.toMatchObject({
            updated: false,
            computed: { outcome: 'replay', reason: 'accepted' }
        });
        expect(await runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE)).toHaveLength(1);
    });

    it('validates receipt identity before expiry cleanup on direct, list, and page reads', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        try {
            const surfaces = ['direct', 'list', 'page'] as const;
            for (const surface of surfaces) {
                const runtimeRepository = new FakeRuntimeStateRepository();
                const repository = new RtcRttRepository(runtimeRepository, {
                    now: () => 10_000
                });
                const rtt = {
                    sessionIdFrom: 'session-a',
                    sessionIdTo: 'session-b',
                    rttMs: 1,
                    createdAtEpochMs: 1,
                    version: 1
                };
                const receiptId = toRtcRttMutationReceiptId(rtt);
                await runtimeRepository.upsert(
                    RTC_RTT_RECEIPTS_NAMESPACE,
                    receiptId,
                    JSON.stringify({
                        receiptId,
                        sessionIdFrom: rtt.sessionIdFrom,
                        sessionIdTo: rtt.sessionIdTo,
                        measurementVersion: rtt.version,
                        affectedGroupRefs: [],
                        acceptedAtEpochMs: 1,
                        outcome: 'accepted',
                        commandHash: `sha256:${'A'.repeat(64)}`
                    }),
                    9_000
                );

                const read = surface === 'direct'
                    ? repository.findMutationReceipt(receiptId)
                    : surface === 'list'
                    ? repository.listMutationReceiptEntries()
                    : repository.listMutationReceiptEntriesPage({
                        limit: 10
                    });
                await expect(read).rejects.toMatchObject({
                    code: 'rtc-topology-repository-invariant-corruption'
                });
                expect(
                    await runtimeRepository.findEntry(RTC_RTT_RECEIPTS_NAMESPACE, receiptId)
                ).toBeDefined();
            }
        }
        finally {
            vi.useRealTimers();
        }
    });
});
