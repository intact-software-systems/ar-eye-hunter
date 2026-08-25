import { describe, expect, it } from 'vitest';

import type {
    RtcTopologyReplayConsumerInput,
    RtcTopologyReplayCursorCasInput,
    RtcTopologyReplayCursorCasResult,
    RtcTopologyReplayEntryHandler,
    RtcTopologyReplayPageInput,
    RtcTopologyReplayPageResult,
    RtcTopologyReplayPort
} from '@shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-contracts.ts';
import type { RtcTopologyReplayDiagnosticsEvent } from '@shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-diagnostics.ts';
import { startApiRtcTopologyReplay } from '../../../apps/api-v1/src/runtime/rtc-topology/rtc-topology-replay-startup.ts';

const STREAM_ID = '00000000-0000-4000-8000-000000000001';

describe('API RTC topology replay startup', () => {
    it('keeps replay consumption absent when the PR 2 default is disabled', async () => {
        const repository = replayRepository();
        const lifecycle = startApiRtcTopologyReplay({
            mode: 'disabled',
            configuration: DELIVERY_CONFIGURATION,
            consumerStreamId: STREAM_ID,
            repository
        });

        lifecycle.wake('notification');
        lifecycle.attach({ entryHandler: entryHandler(), hydrateGap: async () => undefined });
        await expect(lifecycle.readiness).resolves.toBeUndefined();
        expect(repository.initializeConsumerInputs).toEqual([]);
        await lifecycle.stop();
    });

    it('buffers bounded wake sources until enabled replay is attached and ready', async () => {
        const repository = replayRepository();
        const diagnosticsEvents: RtcTopologyReplayDiagnosticsEvent[] = [];
        const lifecycle = startApiRtcTopologyReplay({
            mode: 'enabled',
            configuration: DELIVERY_CONFIGURATION,
            consumerStreamId: STREAM_ID,
            repository,
            diagnostics: (event) => diagnosticsEvents.push(event)
        });

        lifecycle.wake('notification');
        lifecycle.wake('notification');
        lifecycle.wake('local-commit');
        lifecycle.attach({ entryHandler: entryHandler(), hydrateGap: async () => undefined });
        await lifecycle.readiness;
        await lifecycle.whenIdle();

        expect(repository.initializeConsumerInputs).toHaveLength(1);
        expect(repository.discoverPublisherInputs).toHaveLength(2);
        expect(diagnosticsEvents).toEqual(
            expect.arrayContaining([
                { kind: 'wake', source: 'startup' },
                { kind: 'wake', source: 'notification' },
                { kind: 'wake', source: 'local-commit' }
            ])
        );
        await lifecycle.stop();
    });

    it('waits for publisher registration before seeding the consumer cursors', async () => {
        const repository = replayRepository();
        const publisherRegistration = deferred<void>();
        const lifecycle = startApiRtcTopologyReplay({
            mode: 'enabled',
            configuration: DELIVERY_CONFIGURATION,
            consumerStreamId: STREAM_ID,
            repository,
            startupBarrier: publisherRegistration.promise
        });
        lifecycle.attach({ entryHandler: entryHandler(), hydrateGap: async () => undefined });

        await Promise.resolve();
        expect(repository.initializeConsumerInputs).toEqual([]);
        publisherRegistration.resolve();
        await lifecycle.readiness;
        expect(repository.initializeConsumerInputs).toHaveLength(1);
        await lifecycle.stop();
    });

    it('does not seed cursors when shutdown wins the startup-barrier race', async () => {
        const repository = replayRepository();
        const publisherRegistration = deferred<void>();
        const lifecycle = startApiRtcTopologyReplay({
            mode: 'enabled',
            configuration: DELIVERY_CONFIGURATION,
            consumerStreamId: STREAM_ID,
            repository,
            startupBarrier: publisherRegistration.promise
        });
        lifecycle.attach({ entryHandler: entryHandler(), hydrateGap: async () => undefined });

        await lifecycle.stop();
        publisherRegistration.resolve();
        await lifecycle.readiness;

        expect(repository.initializeConsumerInputs).toEqual([]);
    });
});

const DELIVERY_CONFIGURATION = {
    publicationRetentionMs: 86_400_000,
    heartbeatIntervalMs: 10_000,
    leaseDurationMs: 30_000,
    antiEntropyIntervalMs: 1_000,
    pageSize: 100,
    maxPagesPerTurn: 10,
    maxEntriesPerTurn: 1_000,
    compactionIntervalMs: 60_000,
    compactionPageSize: 1_000,
    reconnectBatchWindowMs: 25,
    consumerRetentionMs: 86_400_000
} as const;

function replayRepository(): RtcTopologyReplayPort & {
    readonly initializeConsumerInputs: RtcTopologyReplayConsumerInput[];
    readonly discoverPublisherInputs: RtcTopologyReplayConsumerInput[];
} {
    const initializeConsumerInputs: RtcTopologyReplayConsumerInput[] = [];
    const discoverPublisherInputs: RtcTopologyReplayConsumerInput[] = [];
    return {
        initializeConsumerInputs,
        discoverPublisherInputs,
        initializeConsumer: async (input: RtcTopologyReplayConsumerInput) => {
            initializeConsumerInputs.push(input);
            return [];
        },
        discoverPublishers: async (input: RtcTopologyReplayConsumerInput) => {
            discoverPublisherInputs.push(input);
            return [];
        },
        capturePage: async (_input: RtcTopologyReplayPageInput): Promise<RtcTopologyReplayPageResult> => ({
            status: 'caught-up',
            cursorSequence: 0,
            capturedHeadSequence: 0,
            retainedFromSequence: 1,
            databaseNowEpochMs: 1_000
        }),
        compareAndSetCursor: async (
            _input: RtcTopologyReplayCursorCasInput
        ): Promise<RtcTopologyReplayCursorCasResult> => ({
            status: 'advanced'
        })
    };
}

function entryHandler(): RtcTopologyReplayEntryHandler {
    return { handle: async () => ({ status: 'delivered' }) };
}

function deferred<T>() {
    let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
    const promise = new Promise<T>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}
