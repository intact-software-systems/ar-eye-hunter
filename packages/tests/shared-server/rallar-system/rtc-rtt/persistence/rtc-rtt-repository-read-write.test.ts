import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import { RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE, RTC_RTT_LATEST_NAMESPACE } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-runtime-namespaces.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { describe, expect, it, vi } from 'vitest';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

describe('RTC RTT repository reads and writes', () => {
    it('keeps latest RTT measurements by sorted pair and expires stale entries', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        let now = 1_000;

        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcRttRepository(runtimeRepository, {
                ttlMs: 50,
                now: () => now
            });
            const first = {
                sessionIdFrom: 'session-b',
                sessionIdTo: 'session-a',
                rttMs: 25,
                createdAtEpochMs: 1_000,
                version: 2
            };
            const stale = {
                ...first,
                rttMs: 10,
                version: 1
            };
            const second = {
                ...first,
                rttMs: 5,
                version: 3
            };

            expect(await repository.putMeasurementIfNewer(first)).toBe(true);
            expect(await repository.putMeasurementIfNewer(stale)).toBe(false);
            expect(await repository.putMeasurementIfNewer(second)).toBe(true);

            expect(await repository.findMeasurement('session-a', 'session-b')).toEqual(second);
            expect(await repository.listMeasurementsForSessionIds(['session-a', 'session-b'])).toEqual([
                second
            ]);
            expect(await repository.listMeasurementsForSessionIds(['session-a', 'session-c'])).toEqual(
                []
            );
            now = 1_051;
            vi.setSystemTime(now);
            expect(await repository.findMeasurement('session-a', 'session-b')).toBeUndefined();
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('accepts a newer RTT with its revision guard', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => 1
        });

        await expect(
            repository.putMeasurementIfNewer({
                sessionIdFrom: 'session-a',
                sessionIdTo: 'session-b',
                rttMs: 1,
                createdAtEpochMs: 1,
                version: 1
            })
        ).resolves.toBe(true);
    });

    it('fails closed when the single-attempt RTT write sees equal-version divergence', async () => {
        const repository = new RtcRttRepository(new FakeRuntimeStateRepository(), { now: () => 1 });
        const measurement = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 1,
            createdAtEpochMs: 1,
            version: 1
        };

        await expect(repository.putMeasurementIfNewer(measurement)).resolves.toBe(true);
        await expect(repository.putMeasurementIfNewer({ ...measurement })).resolves.toBe(false);
        await expect(
            repository.putMeasurementIfNewer({
                ...measurement,
                rttMs: 2
            })
        ).rejects.toMatchObject({
            code: 'rtc-topology-repository-invariant-corruption'
        });
    });

    it('surfaces a single-attempt RTT CAS race as a typed conflict', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });
        const competing = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 2,
            createdAtEpochMs: 1,
            version: 1
        };
        runtimeRepository.beforeConditionalWrite = async (operation, namespace, key) => {
            if (operation !== 'insertIfAbsent') {
                return;
            }
            runtimeRepository.beforeConditionalWrite = undefined;
            await runtimeRepository.insertIfAbsent(namespace, key, JSON.stringify(competing), new Date(100).toISOString());
        };

        await expect(
            repository.putMeasurementIfNewer({
                sessionIdFrom: 'session-a',
                sessionIdTo: 'session-b',
                rttMs: 1,
                createdAtEpochMs: 1,
                version: 1
            })
        ).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        await expect(repository.findMeasurement('session-a', 'session-b')).resolves.toEqual(
            competing
        );
    });

    it('uses stable code-unit ordering for Unicode RTT pairs and endpoint peers', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => 1
        });
        const composed = '\u00e9';
        const decomposed = 'e\u0301';
        const measurement = {
            sessionIdFrom: composed,
            sessionIdTo: decomposed,
            rttMs: 1,
            createdAtEpochMs: 1,
            version: 1
        };

        expect(repository.measurementKey(composed, decomposed)).toBe(
            repository.measurementKey(decomposed, composed)
        );
        await expect(repository.commitMeasurement(measurement, null, 100)).resolves.toMatchObject({
            status: 'accepted'
        });
        await expect(repository.findMeasurement(decomposed, composed)).resolves.toEqual(measurement);
        await expect(repository.listMeasurements()).resolves.toEqual([measurement]);
        await expect(repository.listMeasurementEntriesPage({ limit: 10 })).resolves.toMatchObject([
            { value: measurement }
        ]);

        const admission = {
            endpointId: 'endpoint',
            peers: [
                { peerSessionId: decomposed, expiresAtEpochMs: 100 },
                { peerSessionId: composed, expiresAtEpochMs: 101 }
            ],
            version: 1,
            updatedAtEpochMs: 1
        };
        await expect(repository.commitEndpointAdmission(admission, null, 101)).resolves.toMatchObject({
            status: 'accepted'
        });
        await expect(repository.findEndpointAdmissionEntry('endpoint')).resolves.toMatchObject({
            value: admission
        });
        await expect(repository.listEndpointAdmissionEntries()).resolves.toMatchObject([
            { value: admission }
        ]);
        await expect(repository.listEndpointAdmissionEntriesPage({ limit: 10 })).resolves.toMatchObject(
            [{ value: admission }]
        );
    });

    it.each(
        [
            { operation: 'insert', expectedRevision: null, version: 2 },
            { operation: 'update', expectedRevision: 0, version: 1 }
        ] as const
    )(
        'rejects a direct endpoint admission $operation whose domain version differs from its storage guard',
        async ({ expectedRevision, version }) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcRttRepository(runtimeRepository, {
                now: () => 1
            });
            const admission = {
                endpointId: 'session-a',
                peers: [
                    {
                        peerSessionId: 'session-b',
                        expiresAtEpochMs: 100
                    }
                ],
                version,
                updatedAtEpochMs: 1
            };

            await expect(
                repository.commitEndpointAdmission(admission, expectedRevision, 100)
            ).rejects.toBeInstanceOf(TypeError);
            await expect(
                runtimeRepository.findAllEntries(RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE)
            ).resolves.toEqual([]);
        }
    );

    it.each(['direct', 'list', 'page'] as const)(
        'fails closed on endpoint domain/storage version corruption before expiry cleanup on %s reads',
        async (surface) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcRttRepository(runtimeRepository, {
                now: () => 10_000
            });
            const key = repository.endpointAdmissionKey('session-a');
            await runtimeRepository.upsert(
                RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
                key,
                JSON.stringify({
                    endpointId: 'session-a',
                    peers: [
                        {
                            peerSessionId: 'session-b',
                            expiresAtEpochMs: 9_000
                        }
                    ],
                    version: 2,
                    updatedAtEpochMs: 1
                }),
                9_000
            );

            const read = surface === 'direct'
                ? repository.findEndpointAdmissionEntry('session-a')
                : surface === 'list'
                ? repository.listEndpointAdmissionEntries()
                : repository.listEndpointAdmissionEntriesPage({
                    limit: 10
                });
            await expect(read).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption'
            });
            await expect(
                runtimeRepository.findEntry(RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE, key)
            ).resolves.toBeDefined();
        }
    );

    it('keeps expired RTT reads observational without retries or cleanup writes', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        runtimeRepository.beforeConditionalWrite = (operation) => {
            if (operation === 'deleteIfRevision') {
                throw new Error('Expired RTT reads must not delete durable state');
            }
        };
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => 100,
            sleep: rejectUnexpectedRetry
        });
        const measurement = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 1,
            createdAtEpochMs: 1,
            version: 1
        };
        const key = repository.measurementKey('session-a', 'session-b');
        await runtimeRepository.upsert(RTC_RTT_LATEST_NAMESPACE, key, JSON.stringify(measurement), 90);
        const before = await runtimeRepository.findEntry(RTC_RTT_LATEST_NAMESPACE, key);

        await expect(repository.findMeasurement('session-a', 'session-b')).resolves.toBeUndefined();
        await expect(runtimeRepository.findEntry(RTC_RTT_LATEST_NAMESPACE, key)).resolves.toEqual(
            before
        );
    });
});

function rejectUnexpectedRetry(): Promise<never> {
    return Promise.reject(new Error('Expired RTT reads must not enter retry backoff'));
}
