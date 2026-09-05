import type { RtcRttMutationCommand } from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-contracts.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { describe, expect, it, vi } from 'vitest';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    createRttGroupSnapshot,
    executeRtcRttMutation,
    type TestRtcRttLifecycleFacts
} from './rtc-rtt-persistence-test-fixtures.ts';

describe('RTC RTT retry authority', () => {
    it('refreshes lifecycle facts after an RTT conflict crosses peer expiry', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => 0
        });
        const originalBegin = runtimeRepository.begin.bind(runtimeRepository);
        vi.spyOn(runtimeRepository, 'begin')
            .mockImplementationOnce(async () => {
                await repository.commitEndpointAdmission(
                    {
                        endpointId: 'session-a',
                        peers: [
                            {
                                peerSessionId: 'session-c',
                                expiresAtEpochMs: 5
                            }
                        ],
                        version: 1,
                        updatedAtEpochMs: 0
                    },
                    null,
                    5
                );
                throw new RuntimeStateWriteConflictError();
            })
            .mockImplementation(originalBegin);
        const requestedAtEpochMs = [1, 6];
        const readFacts = (): TestRtcRttLifecycleFacts => {
            const requestedAt = requestedAtEpochMs.shift();
            if (requestedAt === undefined) {
                throw new Error('facts exhausted');
            }
            return {
                requestedAtEpochMs: requestedAt,
                purgeAfterEpochMs: requestedAt + 100
            };
        };
        const group = createRttGroupSnapshot('room-ab', ['session-a', 'session-b']);
        const input = {
            repository,
            runtime: runtimeRepository,
            command: {
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
            },
            readFacts
        };

        await expect(executeRtcRttMutation({ ...input, attemptCount: 1 }))
            .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        const result = await executeRtcRttMutation({ ...input, attemptCount: 2 });

        expect(result).toMatchObject({
            updated: true,
            computed: {
                outcome: 'write',
                measurementGuard: { purgeAfterEpochMs: 106 },
                receipt: { acceptedAtEpochMs: 6 }
            }
        });
        if (result.computed.outcome !== 'write') {
            throw new Error('Expected write');
        }
        expect(result.computed.endpointGuards[0]).toMatchObject({
            endpointId: 'session-a',
            value: {
                peers: [
                    {
                        peerSessionId: 'session-b',
                        expiresAtEpochMs: 106
                    }
                ],
                updatedAtEpochMs: 6
            }
        });
        expect(requestedAtEpochMs).toEqual([]);
        await expect(repository.findMeasurementEntry('session-a', 'session-b')).resolves.toMatchObject({
            entry: { expireAtTimestamp: 106 }
        });
    });

    it('fully rereads RTT authority after conflict when a session connection boundary moves past acceptance', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => 0
        });
        const originalBegin = runtimeRepository.begin.bind(runtimeRepository);
        vi.spyOn(runtimeRepository, 'begin')
            .mockImplementationOnce(() => {
                throw new RuntimeStateWriteConflictError();
            })
            .mockImplementation(originalBegin);
        const initial = createRttGroupSnapshot('room-session-boundary', ['session-a', 'session-b']);
        const futureConnection: GroupSnapshot = {
            ...initial,
            activeSessions: initial.activeSessions.map((session) => ({
                ...session,
                generationVersion: 3,
                connectedAtEpochMs: 3,
                lastHeartbeatAtEpochMs: 3
            }))
        };
        const commands = [initial, futureConnection];
        const readCommand = (): RtcRttMutationCommand => {
            const group = commands.shift();
            if (!group) {
                throw new Error('commands exhausted');
            }
            return {
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
        };
        const stableCommand = readCommand();
        commands.unshift(initial);
        const input = {
            repository,
            runtime: runtimeRepository,
            command: stableCommand,
            readCommand,
            readFacts: () => ({
                requestedAtEpochMs: 2,
                purgeAfterEpochMs: 60_002
            })
        };

        await expect(executeRtcRttMutation({ ...input, attemptCount: 1 }))
            .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        const result = await executeRtcRttMutation({ ...input, attemptCount: 2 });

        expect(result).toMatchObject({
            updated: false,
            computed: {
                outcome: 'rejected',
                reason: 'no-shared-active-group'
            }
        });
        expect(commands).toEqual([]);
        await expect(repository.findMeasurement('session-a', 'session-b')).resolves.toBeUndefined();
    });
});
