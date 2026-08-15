import { describe, expect, it, vi } from 'vitest';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository.ts';
import {
    RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
    RTC_RTT_LATEST_NAMESPACE,
} from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-runtime-namespaces.ts';

import { FakeRuntimeStateRepository } from '../../../fake-runtime-state-repository.ts';

describe('RTC RTT persistence corruption', () => {
    it('rejects wrong-pair RTT rows before expiry across direct, list, and page reads', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcRttRepository(
                runtimeRepository,
            ) as RtcRttRepository & {
                listMeasurementEntriesPage(input: {
                    afterKey?: string;
                    limit: number;
                }): Promise<readonly unknown[]>;
            };
            const requestedKey = repository.measurementKey(
                'session-a',
                'session-b',
            );
            await runtimeRepository.upsert(
                RTC_RTT_LATEST_NAMESPACE,
                requestedKey,
                JSON.stringify({
                    sessionIdFrom: 'session-a',
                    sessionIdTo: 'session-c',
                    rttMs: 1,
                    createdAtEpochMs: 1,
                    version: 1,
                }),
                9_000,
            );

            await expect(
                repository.findMeasurement('session-a', 'session-b'),
            ).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
            await expect(repository.listMeasurements()).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
            await expect(
                repository.listMeasurementEntriesPage({ limit: 10 }),
            ).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
            expect(
                await runtimeRepository.findEntry(
                    RTC_RTT_LATEST_NAMESPACE,
                    requestedKey,
                ),
            ).toBeDefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses injective RTT keys and validates endpoint admission direct, list, and page rows', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcRttRepository(runtimeRepository, {
                now: () => 10_000,
            });
            expect(repository.measurementKey('a', 'b:c')).not.toBe(
                repository.measurementKey('a:b', 'c'),
            );
            expect(repository.measurementKey('a%', '＿')).not.toBe(
                repository.measurementKey('a', '%＿'),
            );
            const key = repository.endpointAdmissionKey('session-a');
            await runtimeRepository.upsert(
                RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
                key,
                JSON.stringify({
                    endpointId: 'session-b',
                    peers: [
                        {
                            peerSessionId: 'session-c',
                            expiresAtEpochMs: 11_000,
                        },
                    ],
                    version: 1,
                    updatedAtEpochMs: 9_000,
                }),
                11_000,
            );

            await expect(
                repository.findEndpointAdmissionEntry('session-a'),
            ).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
            await expect(
                repository.listEndpointAdmissionEntries(),
            ).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
            await expect(
                repository.listEndpointAdmissionEntriesPage({ limit: 10 }),
            ).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
            expect(
                await runtimeRepository.findEntry(
                    RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
                    key,
                ),
            ).toBeDefined();
        } finally {
            vi.useRealTimers();
        }
    });
});
