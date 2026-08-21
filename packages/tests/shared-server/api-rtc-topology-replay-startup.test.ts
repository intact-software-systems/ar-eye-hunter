import { describe, expect, it, vi } from 'vitest';

import type {
    RtcTopologyReplayConsumerInput,
    RtcTopologyReplayCursorCasInput,
    RtcTopologyReplayCursorCasResult,
    RtcTopologyReplayPageInput,
    RtcTopologyReplayPageResult
} from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-contracts.ts';
import type { RtcTopologyReplayEntryHandler, RtcTopologyReplayPort } from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-service.ts';
import { startApiRtcTopologyReplay } from '../../../apps/api-v1/src/runtime/rtc-topology/rtc-topology-replay-startup.ts';

const STREAM_ID = '00000000-0000-4000-8000-000000000001';

describe('API RTC topology replay startup', () => {
    it('keeps replay consumption absent when the PR 2 default is disabled', async () => {
        const repository = replayRepository();
        const lifecycle = startApiRtcTopologyReplay({
            mode: 'disabled',
            consumerStreamId: STREAM_ID,
            repository
        });

        lifecycle.wake('notification');
        lifecycle.attach({ entryHandler: entryHandler(), hydrateGap: async () => undefined });
        await expect(lifecycle.readiness).resolves.toBeUndefined();
        expect(repository.initializeConsumer).not.toHaveBeenCalled();
        await lifecycle.stop();
    });

    it('buffers bounded wake sources until enabled replay is attached and ready', async () => {
        const repository = replayRepository();
        const diagnostics = vi.fn();
        const lifecycle = startApiRtcTopologyReplay({
            mode: 'enabled',
            consumerStreamId: STREAM_ID,
            repository,
            diagnostics
        });

        lifecycle.wake('notification');
        lifecycle.wake('notification');
        lifecycle.wake('local-commit');
        lifecycle.attach({ entryHandler: entryHandler(), hydrateGap: async () => undefined });
        await lifecycle.readiness;
        await lifecycle.whenIdle();

        expect(repository.initializeConsumer).toHaveBeenCalledOnce();
        expect(repository.discoverPublishers).toHaveBeenCalledTimes(2);
        expect(diagnostics).toHaveBeenCalledWith({ kind: 'wake', source: 'startup' });
        expect(diagnostics).toHaveBeenCalledWith({ kind: 'wake', source: 'notification' });
        expect(diagnostics).toHaveBeenCalledWith({ kind: 'wake', source: 'local-commit' });
        await lifecycle.stop();
    });

    it('waits for publisher registration before seeding the consumer cursors', async () => {
        const repository = replayRepository();
        const publisherRegistration = deferred<void>();
        const lifecycle = startApiRtcTopologyReplay({
            mode: 'enabled',
            consumerStreamId: STREAM_ID,
            repository,
            startupBarrier: publisherRegistration.promise
        });
        lifecycle.attach({ entryHandler: entryHandler(), hydrateGap: async () => undefined });

        await Promise.resolve();
        expect(repository.initializeConsumer).not.toHaveBeenCalled();
        publisherRegistration.resolve();
        await lifecycle.readiness;
        expect(repository.initializeConsumer).toHaveBeenCalledOnce();
        await lifecycle.stop();
    });

    it('does not seed cursors when shutdown wins the startup-barrier race', async () => {
        const repository = replayRepository();
        const publisherRegistration = deferred<void>();
        const lifecycle = startApiRtcTopologyReplay({
            mode: 'enabled',
            consumerStreamId: STREAM_ID,
            repository,
            startupBarrier: publisherRegistration.promise
        });
        lifecycle.attach({ entryHandler: entryHandler(), hydrateGap: async () => undefined });

        await lifecycle.stop();
        publisherRegistration.resolve();
        await lifecycle.readiness;

        expect(repository.initializeConsumer).not.toHaveBeenCalled();
    });
});

function replayRepository(): RtcTopologyReplayPort & {
    initializeConsumer: ReturnType<typeof vi.fn>;
    discoverPublishers: ReturnType<typeof vi.fn>;
} {
    return {
        initializeConsumer: vi.fn(async (_input: RtcTopologyReplayConsumerInput) => []),
        discoverPublishers: vi.fn(async (_input: RtcTopologyReplayConsumerInput) => []),
        capturePage: vi.fn(
            async (_input: RtcTopologyReplayPageInput): Promise<RtcTopologyReplayPageResult> => ({
                status: 'caught-up',
                cursorSequence: 0,
                capturedHeadSequence: 0,
                retainedFromSequence: 1,
                databaseNowEpochMs: 1_000
            })
        ),
        compareAndSetCursor: vi.fn(
            async (
                _input: RtcTopologyReplayCursorCasInput
            ): Promise<RtcTopologyReplayCursorCasResult> => ({
                status: 'advanced'
            })
        )
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
