import { describe, expect, it } from 'vitest';
import { migrateLegacyRtcRttMeasurementKeys } from '@shared-server/rallar-system/rtc-topology/persistence/migrate-legacy-rtc-rtt-measurement-keys.ts';
import { migrateLegacyRtcRttRecomputeIntentDeliveryState } from '@shared-server/rallar-system/rtc-topology/persistence/migrate-legacy-rtc-rtt-recompute-intents.ts';
import { DEFAULT_RTC_RTT_MUTATION_RETENTION_MS } from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-persistence-validation.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository.ts';
import {
    RTC_RTT_LATEST_NAMESPACE,
    RTC_RTT_RECEIPTS_NAMESPACE,
    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
} from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-runtime-namespaces.ts';

import { FakeRuntimeStateRepository } from '../../../fake-runtime-state-repository.ts';
import { createValidRttWriteCandidate } from './rtc-rtt-persistence-test-fixtures.ts';

describe('RTC RTT persistence migration', () => {
    it('offline-migrates value-verified legacy RTT pair keys', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => 1,
        });
        const measurement = {
            sessionIdFrom: 'session-b',
            sessionIdTo: 'session-a',
            rttMs: 4,
            createdAtEpochMs: 1,
            version: 1,
        };
        const legacyKey = `pair=${encodeURIComponent('session-a::session-b')}`;
        await repository.commitMeasurement(measurement, null, 60_001);
        await runtimeRepository.upsert(
            RTC_RTT_LATEST_NAMESPACE,
            legacyKey,
            JSON.stringify(measurement),
            60_001,
        );

        await migrateLegacyRtcRttMeasurementKeys(repository, {
            oldWritersStopped: true,
        });
        await migrateLegacyRtcRttMeasurementKeys(repository, {
            oldWritersStopped: true,
        });

        expect(
            await repository.findMeasurement('session-a', 'session-b'),
        ).toEqual(measurement);
        expect(
            await runtimeRepository.findEntry(
                RTC_RTT_LATEST_NAMESPACE,
                legacyKey,
            ),
        ).toBeUndefined();
    });

    it('offline-upgrades retained recompute intents without restoring runtime ownership', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtime, { now: () => 1 });
        const candidate = createValidRttWriteCandidate();
        const intent = candidate.recomputeIntents[0]!;
        const {
            senderId: _senderId,
            delivery: _delivery,
            ...legacyIntent
        } = intent;
        const expireAtEpochMs =
            candidate.receipt.acceptedAtEpochMs +
            DEFAULT_RTC_RTT_MUTATION_RETENTION_MS;
        await runtime.insertIfAbsent(
            RTC_RTT_RECEIPTS_NAMESPACE,
            candidate.receipt.receiptId,
            JSON.stringify(candidate.receipt),
            expireAtEpochMs,
        );
        await runtime.insertIfAbsent(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            intent.outboxId,
            JSON.stringify(legacyIntent),
            expireAtEpochMs,
        );

        await migrateLegacyRtcRttRecomputeIntentDeliveryState(repository, {
            oldWritersStopped: true,
        });

        const upgraded = await runtime.findEntry(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            intent.outboxId,
        );
        expect(JSON.parse(upgraded!.value)).toEqual({
            ...legacyIntent,
            senderId: 'rallar-server-legacy-migration',
            delivery: { state: 'pending' },
        });
    });
});
