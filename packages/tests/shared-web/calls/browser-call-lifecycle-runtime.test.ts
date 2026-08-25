import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { BrowserCallLifecycleRuntime } from '@shared-web/browser/calls/browser-call-lifecycle-runtime.ts';
import type { BrowserCallSessionRuntime } from '@shared-web/browser/calls/browser-call-session-runtime.ts';
import type { RallarMediaFacade } from '@shared-web/browser/rallar-media-facade.ts';
import type { RallarTargetedChannel } from '@shared-web/browser/rallar-realtime-facade.ts';
import type {
    RallarRtcFacade,
    RallarRtcStatus,
    RallarRtcWaitForOpenResult
} from '@shared-web/browser/rallar-rtc-facade.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('BrowserCallLifecycleRuntime', () => {
    afterEach(() => vi.useRealTimers());

    it('captures fixed membership and start time after connection completes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(100);
        let peerIds = ['peer-before-connect'];
        const connect = vi.fn(async () => {
            peerIds = ['peer-after-connect'];
            vi.setSystemTime(250);
            return toTestDouble<ApiMiddleware>({});
        });
        const lifecycle = new BrowserCallLifecycleRuntime(
            createCallLifecycleInput({
                connect,
                resolveTargetPeerIds: () => peerIds
            })
        );

        const call = await lifecycle.start({});

        expect(call.status()).toMatchObject({
            peerIds: ['peer-after-connect'],
            startedAtEpochMs: 250
        });
    });
});

function createCallLifecycleInput(
    overrides: Partial<BrowserCallSessionRuntime.Input> = {}
): BrowserCallSessionRuntime.Input {
    return {
        connect: async () => toTestDouble<ApiMiddleware>({}),
        readMiddleware: () => undefined,
        resolveTargetPeerIds: () => [],
        createTargetedChannel: <T>() => toTestDouble<RallarTargetedChannel<T>>({}),
        rtc: toTestDouble<RallarRtcFacade>({
            waitForLane: async (peerId, laneId) => toTestDouble<RallarRtcWaitForOpenResult>({
                transport: 'rtc',
                status: 'no-peer',
                peerId,
                laneId
            }),
            status: () => toTestDouble<RallarRtcStatus>({
                knownPeerIds: [],
                activePeerIds: [],
                readyPeerIds: [],
                peers: []
            })
        }),
        media: toTestDouble<RallarMediaFacade>({
            microphone: toTestDouble<RallarMediaFacade['microphone']>({}),
            camera: toTestDouble<RallarMediaFacade['camera']>({}),
            screen: toTestDouble<RallarMediaFacade['screen']>({})
        }),
        readSourceStatuses: () => [],
        ...overrides
    };
}

function toTestDouble<T>(members: Partial<T>): T {
    return members as T;
}
