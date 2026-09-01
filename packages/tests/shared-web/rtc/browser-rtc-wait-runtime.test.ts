import {
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID } from '@shared/services/web-rtc-connection-service.ts';

import { createBrowserRtcPeerTestDouble } from './browser-rtc-peer-test-double.ts';
import {
    createChannelHealth,
    readRtcWaitMocks,
    resetRtcWaitTestRuntime
} from './browser-rtc-wait-test-runtime.ts';

const mocks = readRtcWaitMocks();

describe('Rallar RTC peer wait', () => {
    beforeEach(resetRtcWaitTestRuntime);

    it('waits for the default RTC lane to open', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        let readyState: RTCDataChannelState = 'connecting';
        let state = 'Opening';
        const channel = {
            readHealth: vi.fn(() =>
                createChannelHealth({
                    peerId: 'peer-1',
                    label: 'rtc-data-channel',
                    state,
                    readyState
                })
            ),
            waitUntilOpen: vi.fn(async () => {
                readyState = 'open';
                state = 'Open';
                return true;
            })
        };
        const peer = createBrowserRtcPeerTestDouble({ peerId: 'peer-1', channels: [['reliable', channel]] });
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();

        await expect(facade.rtc.waitForOpen('peer-1', { timeoutMs: 25 }))
            .resolves.toMatchObject({
                transport: 'rtc',
                status: 'open',
                peerId: 'peer-1',
                laneId: 'reliable',
                lane: {
                    isOpen: true
                }
            });
        expect(channel.waitUntilOpen).toHaveBeenCalledWith(25);
    });

    it('does not connect an RTC peer when wait is observe-only', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();

        await facade.connect();
        mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockClear();
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockClear();
        const connectionAttempts = rejectUnexpectedRtcConnectionAttempts();

        await expect(facade.rtc.waitForOpen('peer-1', { timeoutMs: 1 }))
            .resolves.toMatchObject({
                transport: 'rtc',
                status: 'no-peer',
                peerId: 'peer-1',
                laneId: 'reliable'
            });
        expect(connectionAttempts).toEqual([]);
    });

    it('returns aborted for an already-aborted RTC lane wait', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const controller = new AbortController();
        controller.abort();
        const facade = createRallarFacade();

        await facade.connect();
        mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockClear();
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockClear();
        const connectionAttempts = rejectUnexpectedRtcConnectionAttempts();

        await expect(
            facade.rtc.waitForLane(
                'peer-1',
                'realtime',
                {
                    signal: controller.signal,
                    connect: true
                }
            )
        ).resolves.toMatchObject({
            transport: 'rtc',
            status: 'aborted',
            peerId: 'peer-1',
            laneId: 'realtime'
        });
        expect(connectionAttempts).toEqual([]);
    });

    it('returns no-lane when an RTC peer lacks the requested lane', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const peer = createBrowserRtcPeerTestDouble({ peerId: 'peer-1', channels: [] });
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();

        await expect(facade.rtc.waitForLane('peer-1', 'realtime'))
            .resolves.toMatchObject({
                transport: 'rtc',
                status: 'no-lane',
                peerId: 'peer-1',
                laneId: 'realtime'
            });
    });

    it('returns closed when an RTC lane is already closed', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const channel = {
            readHealth: vi.fn(() =>
                createChannelHealth({
                    peerId: 'peer-1',
                    label: 'rtc-realtime',
                    state: 'Closed',
                    readyState: 'closed'
                })
            ),
            waitUntilOpen: () => {
                throw new Error('A closed lane cannot be awaited');
            }
        };
        const peer = createBrowserRtcPeerTestDouble({ peerId: 'peer-1', channels: [['realtime', channel]] });
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();

        await expect(facade.rtc.waitForLane('peer-1', 'realtime'))
            .resolves.toMatchObject({
                transport: 'rtc',
                status: 'closed',
                peerId: 'peer-1',
                laneId: 'realtime',
                lane: {
                    isReconnectable: true
                }
            });
    });

    it('returns aborted when RTC lane wait is aborted while pending', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const deferred = Promise.withResolvers<boolean>();
        const channel = {
            readHealth: vi.fn(() =>
                createChannelHealth({
                    peerId: 'peer-1',
                    label: 'rtc-realtime',
                    state: 'Opening',
                    readyState: 'connecting'
                })
            ),
            waitUntilOpen: vi.fn(() => deferred.promise)
        };
        const peer = createBrowserRtcPeerTestDouble({ peerId: 'peer-1', channels: [['realtime', channel]] });
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();
        const controller = new AbortController();

        await facade.connect();
        const wait = facade.rtc.waitForLane(
            'peer-1',
            'realtime',
            {
                signal: controller.signal,
                timeoutMs: 1_000
            }
        );
        controller.abort();

        await expect(wait).resolves.toMatchObject({
            transport: 'rtc',
            status: 'aborted',
            peerId: 'peer-1',
            laneId: 'realtime'
        });
        expect(channel.waitUntilOpen).toHaveBeenCalledWith(1_000);
        deferred.resolve(false);
    });

    it('returns failed when opt-in RTC peer connection throws', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen
            .mockRejectedValueOnce(new Error('signaling failed'));
        const facade = createRallarFacade();

        await facade.connect();

        await expect(
            facade.rtc.waitForLane(
                'peer-1',
                'realtime',
                {
                    connect: true,
                    timeoutMs: 25
                }
            )
        ).resolves.toMatchObject({
            transport: 'rtc',
            status: 'failed',
            peerId: 'peer-1',
            laneId: 'realtime',
            reason: 'signaling failed'
        });
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 25
                })
            );
    });

    it('can opt into connecting an RTC peer before waiting for a lane', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const channel = {
            readHealth: vi.fn(() =>
                createChannelHealth({
                    peerId: 'peer-1',
                    label: 'rtc-realtime',
                    state: 'Open',
                    readyState: 'open'
                })
            )
        };
        const peer = createBrowserRtcPeerTestDouble({ peerId: 'peer-1', channels: [['realtime', channel]] });
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValueOnce({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'realtime',
            peer,
            channel: peer.channel
        });
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        const facade = createRallarFacade();

        await facade.connect();

        await expect(
            facade.rtc.waitForLane(
                'peer-1',
                'realtime',
                {
                    connect: true,
                    timeoutMs: 50
                }
            )
        ).resolves.toMatchObject({
            transport: 'rtc',
            status: 'open',
            peerId: 'peer-1',
            laneId: 'realtime'
        });
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 50
                })
            );
    });
});

function rejectUnexpectedRtcConnectionAttempts(): string[] {
    const attempts: string[] = [];
    mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockImplementation(
        (peerId) => {
            attempts.push(`connect:${peerId}`);
            throw new Error(`Unexpected RTC connection attempt for ${peerId}`);
        }
    );
    mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
        async (peerId, laneId = 'reliable') => {
            attempts.push(`open:${peerId}:${laneId}`);
            throw new Error(`Unexpected RTC lane open for ${peerId}:${laneId}`);
        }
    );
    return attempts;
}
