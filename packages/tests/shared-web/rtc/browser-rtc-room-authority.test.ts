import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { RallarFacade } from '@shared-web/browser/rallar-facade-contract.ts';
import type { StateCacheChangeListener } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';

import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime,
    type SimulatedNativeRtcDataChannel,
    type SimulatedNativeRtcPeerConnection
} from '../../shared/native-rtc-connection-fixture.ts';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import {
    createAcceptedOverlay,
    createGroupSnapshot,
    mockAcceptedOverlay,
    mockGroupSnapshots,
    readRtcWaitMocks,
    resetRtcWaitTestRuntime
} from './browser-rtc-wait-test-runtime.ts';

interface NativeRoomFixture {
    readonly facade: RallarFacade;
    readonly service: WebRtcConnectionService;
    readonly peer: SimulatedNativeRtcPeerConnection;
    readonly lane: SimulatedNativeRtcDataChannel;
    nativePeer(peerId: string): SimulatedNativeRtcPeerConnection;
}

installFakeBroadcastChannelPerTest();

describe('room RTC authority and native progress', () => {
    beforeEach(resetRtcWaitTestRuntime);

    it.each(['before', 'after'] as const)('returns the minimum with a lane opened %s waiting and releases only its own waits', async (openedAt) => {
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-a', 'peer-b']);
        const fixture = await createNativeRoomFixture([room]);
        fixture.service.ensurePeerConnectionStarted('peer-b', true);
        const otherLane = fixture.nativePeer('peer-b').channels.find((channel) => channel.label === 'reliable');
        if (!otherLane) {
            throw new Error('Second native reliable lane was not created');
        }
        vi.useFakeTimers();
        try {
            if (openedAt === 'before') {
                await fixture.lane.open();
            }
            const timersBefore = vi.getTimerCount();
            const callbackCountsBefore = fixture.service.knownPeerIds().map((peerId) =>
                fixture.service.readPeer(peerId)?.channels.get('reliable')?.readHealth().lifecycleCallbackCount
            );
            const pending = fixture.facade.rtc.waitForRoom(room.group, { minReadyPeers: 1, timeoutMs: 1_000 });
            let settled = false;
            void pending.then(() => {
                settled = true;
            });
            if (openedAt === 'after') {
                await fixture.lane.open();
            }
            await vi.advanceTimersByTimeAsync(0);
            expect(settled).toBe(true);
            await expect(pending).resolves.toMatchObject({
                rtc: { state: 'partial', desiredPeerIds: ['peer-a', 'peer-b'], readyPeerIds: ['peer-a'] }
            });
            expect(vi.getTimerCount()).toBe(timersBefore);
            expect(
                fixture.service.knownPeerIds().map((peerId) => fixture.service.readPeer(peerId)?.channels.get('reliable')?.readHealth().lifecycleCallbackCount)
            ).toEqual(callbackCountsBefore);
            expect(otherLane.readyState).toBe('connecting');
            expect(fixture.service.knownPeerIds()).toEqual(['peer-a', 'peer-b']);
            await otherLane.open();
            await expect(fixture.facade.rtc.waitForRoom(room.group, { timeoutMs: 1_000 })).resolves.toMatchObject({
                rtc: { state: 'open', readyPeerIds: ['peer-a', 'peer-b'] }
            });
        }
        finally {
            vi.useRealTimers();
        }
    });

    it.each([undefined, 2])('waits for all lanes when the minimum is %s', async (minReadyPeers) => {
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-a', 'peer-b']);
        const fixture = await createNativeRoomFixture([room]);
        fixture.service.ensurePeerConnectionStarted('peer-b', true);
        const otherLane = fixture.nativePeer('peer-b').channels.find((channel) => channel.label === 'reliable');
        if (!otherLane) {
            throw new Error('Second native reliable lane was not created');
        }
        let settled = false;
        const pending = fixture.facade.rtc.waitForRoom(room.group, { minReadyPeers, timeoutMs: 1_000 });
        void pending.then(() => {
            settled = true;
        });
        await fixture.lane.open();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(false);
        await otherLane.open();
        await expect(pending).resolves.toMatchObject({ rtc: { state: 'open', readyPeerIds: ['peer-a', 'peer-b'] } });
    });

    it.each(['abort', 'timeout'] as const)('releases real minimum-readiness waiters after %s and permits recovery', async (termination) => {
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-a']);
        const fixture = await createNativeRoomFixture([room]);
        const controller = new AbortController();
        vi.useFakeTimers();
        try {
            const timersBefore = vi.getTimerCount();
            const pending = fixture.facade.rtc.waitForRoom(room.group, {
                minReadyPeers: 1,
                timeoutMs: 100,
                signal: controller.signal
            });
            await Promise.resolve();
            if (termination === 'abort') {
                controller.abort();
            }
            else {
                await vi.advanceTimersByTimeAsync(100);
            }
            await expect(pending).resolves.toMatchObject({ rtc: { reason: `Room RTC wait ended with ${termination === 'abort' ? 'aborted' : 'timeout'}.` } });
            expect(vi.getTimerCount()).toBe(timersBefore);
            expect(fixture.lane.readyState).toBe('connecting');
            await fixture.lane.open();
            await expect(fixture.facade.rtc.waitForRoom(room.group, { minReadyPeers: 1, timeoutMs: 100 })).resolves.toMatchObject({
                rtc: { state: 'open', readyPeerIds: ['peer-a'] }
            });
        }
        finally {
            vi.useRealTimers();
        }
    });

    it.each(['halt', 'local-departure', 'peer-departure', 'replacement'] as const)(
        'rechecks current authority after minimum readiness settles during %s cleanup',
        async (change) => {
            const room = createGroupSnapshot('room-1', ['session-1', 'peer-a', 'peer-b']);
            const fixture = await createNativeRoomFixture([room]);
            readRtcWaitMocks().onCacheChange.mockImplementation(() => () => changeRoomAuthority(room, change));
            const pending = fixture.facade.rtc.waitForRoom(room.group, { minReadyPeers: 1, timeoutMs: 1_000 });
            await fixture.lane.open();
            const result = await pending;
            expect(result.rtc.readyPeerIds).toEqual(change === 'halt' ? ['peer-a'] : []);
            expect(['open', 'partial']).not.toContain(result.rtc.state);
            expect(fixture.service.knownPeerIds()).toContain('peer-a');
        }
    );

    it.each(['abort', 'timeout'] as const)('keeps %s terminal if a native lane opens during observation cleanup', async (termination) => {
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-a']);
        const fixture = await createNativeRoomFixture([room]);
        readRtcWaitMocks().onCacheChange.mockImplementation(() => () => {
            void fixture.lane.open();
        });
        const controller = new AbortController();
        vi.useFakeTimers();
        try {
            const pending = fixture.facade.rtc.waitForRoom(room.group, {
                minReadyPeers: 1,
                signal: controller.signal,
                timeoutMs: 100
            });
            if (termination === 'abort') {
                controller.abort();
            }
            else {
                await vi.advanceTimersByTimeAsync(100);
            }
            await expect(pending).resolves.toMatchObject({
                rtc: { state: 'idle', readyPeerIds: ['peer-a'], reason: `Room RTC wait ended with ${termination === 'abort' ? 'aborted' : 'timeout'}.` }
            });
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('does not start peer work for a pre-aborted minimum wait even if one lane is ready', async () => {
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-a', 'peer-b']);
        const fixture = await createNativeRoomFixture([room]);
        await fixture.lane.open();
        const controller = new AbortController();
        controller.abort();
        await expect(fixture.facade.rtc.waitForRoom(room.group, {
            minReadyPeers: 1,
            signal: controller.signal,
            timeoutMs: 100
        })).resolves.toMatchObject({ rtc: { state: 'idle', reason: 'Room RTC wait ended with aborted.' } });
        expect(fixture.service.knownPeerIds()).toEqual(['peer-a']);
    });

    it.each(['close', 'fail'] as const)('rechecks a formerly ready lane that %ss during minimum-wait cleanup', async (change) => {
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-a', 'peer-b']);
        const fixture = await createNativeRoomFixture([room]);
        readRtcWaitMocks().onCacheChange.mockImplementation(() => () => {
            void fixture.lane[change]();
        });
        const pending = fixture.facade.rtc.waitForRoom(room.group, { minReadyPeers: 1, timeoutMs: 100 });
        await fixture.lane.open();
        const result = await pending;
        expect(result.rtc.readyPeerIds).toEqual([]);
        expect(['open', 'partial']).not.toContain(result.rtc.state);
    });

    it('cleans up when the parent aborts during synchronous observation registration', async () => {
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-a']);
        const fixture = await createNativeRoomFixture([room]);
        const controller = new AbortController();
        readRtcWaitMocks().onCacheChange.mockImplementation(() => {
            controller.abort();
            return () => {};
        });
        vi.useFakeTimers();
        try {
            const timersBefore = vi.getTimerCount();
            await expect(fixture.facade.rtc.waitForRoom(room.group, {
                minReadyPeers: 1,
                signal: controller.signal,
                timeoutMs: 100
            })).resolves.toMatchObject({ rtc: { state: 'idle', reason: 'Room RTC wait ended with aborted.' } });
            expect(vi.getTimerCount()).toBe(timersBefore);
            expect(fixture.lane.readyState).toBe('connecting');
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('shares one deadline between accepted-authority arrival and minimum lane readiness', async () => {
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-a']);
        const fixture = await createNativeRoomFixture([room]);
        mockGroupSnapshots([room], []);
        const listeners = new Set<StateCacheChangeListener>();
        readRtcWaitMocks().onCacheChange.mockImplementation((listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        });
        vi.useFakeTimers();
        try {
            const pending = fixture.facade.rtc.waitForRoom(room.group, { minReadyPeers: 1, timeoutMs: 100 });
            let settled = false;
            void pending.then(() => {
                settled = true;
            });
            await vi.advanceTimersByTimeAsync(60);
            mockAcceptedOverlay(room, ['session-1', 'peer-a']);
            for (const listener of listeners) {
                await listener({ clients: [], groups: [room] });
            }
            await vi.advanceTimersByTimeAsync(39);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await expect(pending).resolves.toMatchObject({ rtc: { reason: 'Room RTC wait ended with timeout.' } });
            expect(listeners.size).toBe(0);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('keeps connecting and open lanes out of failed peers, and reports actual lane failure', async () => {
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-a']);
        const fixture = await createNativeRoomFixture([room]);

        expect(fixture.facade.rtc.roomStatus(room.group).rtc).toMatchObject({
            state: 'connecting',
            readyPeerIds: [],
            failedPeerIds: []
        });
        await fixture.lane.open();
        expect(fixture.facade.rtc.roomStatus(room.group).rtc).toMatchObject({
            state: 'open',
            readyPeerIds: ['peer-a'],
            failedPeerIds: []
        });
        await fixture.lane.fail();
        expect(fixture.facade.rtc.roomStatus(room.group).rtc).toMatchObject({
            state: 'failed',
            readyPeerIds: [],
            failedPeerIds: ['peer-a']
        });
    });

    it('reports a failed native peer connection even if its lane last reported open', async () => {
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-a']);
        const fixture = await createNativeRoomFixture([room]);
        await fixture.lane.open();
        fixture.peer.connectionState = 'failed';
        fixture.peer.onconnectionstatechange?.call(fixture.peer, new Event('connectionstatechange'));

        expect(fixture.facade.rtc.roomStatus(room.group).rtc).toMatchObject({
            state: 'failed',
            readyPeerIds: [],
            failedPeerIds: ['peer-a']
        });
    });

    it('does not report a room peer ready after ICE fails before the aggregate connection state updates', async () => {
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-a']);
        const fixture = await createNativeRoomFixture([room]);
        await fixture.lane.open();
        fixture.peer.setConnected();
        fixture.peer.iceConnectionState = 'failed';
        fixture.peer.oniceconnectionstatechange?.call(fixture.peer, new Event('iceconnectionstatechange'));

        expect(fixture.facade.rtc.roomStatus(room.group).rtc).toMatchObject({
            state: 'failed',
            readyPeerIds: [],
            failedPeerIds: ['peer-a']
        });
    });

    it('excludes departed room peers while their connection remains ready for another room', async () => {
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-a']);
        const other = createGroupSnapshot('room-2', ['session-1', 'peer-a']);
        const fixture = await createNativeRoomFixture([room, other]);
        await fixture.lane.open();
        mockGroupSnapshots(
            [withoutPresence(room, 'peer-a'), other],
            [createAcceptedOverlay(room), createAcceptedOverlay(other)]
        );

        expect(fixture.facade.rtc.roomStatus(room.group).rtc).toMatchObject({
            desiredPeerIds: [],
            readyPeerIds: [],
            peers: []
        });
        expect(fixture.facade.rtc.roomStatus(other.group).rtc.readyPeerIds).toEqual(['peer-a']);
        expect(fixture.service.knownPeerIds()).toEqual(['peer-a']);
    });

    it.each(['halt', 'local-departure', 'peer-departure', 'replacement'] as const)(
        'reauthorizes a pending room lane result after %s',
        async (change) => {
            const room = createGroupSnapshot('room-1', ['session-1', 'peer-a', 'peer-b']);
            const fixture = await createNativeRoomFixture([room]);
            mockAcceptedOverlay(room, ['peer-a']);
            const pending = fixture.facade.rtc.waitForRoomLane(room.group, 'reliable', {
                connect: false,
                timeoutMs: 1_000,
                expect: { sessionIds: ['peer-a'] }
            });

            changeRoomAuthority(room, change);
            await fixture.lane.open();

            expect(await pending).toMatchObject({
                status: 'empty',
                ready: [],
                readyPeerIds: [],
                observedCount: 0,
                missingPeerIds: ['peer-a'],
                expectedCount: 1
            });
        }
    );

    it.each(['close', 'fail'] as const)('rechecks an earlier ready lane after it later %ss while another peer is pending', async (change) => {
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-a', 'peer-b']);
        const fixture = await createNativeRoomFixture([room]);
        fixture.service.ensurePeerConnectionStarted('peer-b', true);
        const otherLane = fixture.nativePeer('peer-b').channels.find((channel) => channel.label === 'reliable');
        if (!otherLane) {
            throw new Error('Second native reliable lane was not created');
        }
        await fixture.lane.open();
        const pending = fixture.facade.rtc.waitForRoomLane(room.group, 'reliable', { connect: false, timeoutMs: 1_000 });

        await fixture.lane[change]();
        await otherLane.open();

        expect(await pending).toMatchObject({
            status: 'partial',
            readyPeerIds: ['peer-b'],
            notReadyPeerIds: ['peer-a'],
            ready: [{ peerId: 'peer-b', status: 'open' }],
            notReady: [{ peerId: 'peer-a', status: 'closed', lane: { isOpen: false } }]
        });
    });

    it('pins direct room lane reauthorization to its original workspace', async () => {
        const room = createGroupSnapshot('shared-room', ['session-1', 'peer-a'], { workspaceId: 'workspace-a' });
        const other = createGroupSnapshot('shared-room', ['session-1', 'peer-a'], { workspaceId: 'workspace-b' });
        const fixture = await createNativeRoomFixture([room, other]);
        fixture.facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-a' });
        const pending = fixture.facade.rtc.waitForRoomLane('shared-room', 'reliable', {
            connect: false,
            timeoutMs: 1_000
        });

        fixture.facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-b' });
        mockGroupSnapshots(
            [withoutPresence(room, 'peer-a'), other],
            [createAcceptedOverlay(room), createAcceptedOverlay(other)]
        );
        await fixture.lane.open();

        expect(await pending).toMatchObject({ status: 'empty', readyPeerIds: [], observedCount: 0 });
        expect(fixture.facade.rtc.roomStatus(other.group).rtc.readyPeerIds).toEqual(['peer-a']);
    });

    it.each(['waitForRoom', 'openRoom'] as const)('pins %s status to the room whose lane was awaited', async (operation) => {
        const room = createGroupSnapshot('shared-room', ['session-1', 'peer-a'], { workspaceId: 'workspace-a' });
        const other = createGroupSnapshot('shared-room', ['session-1'], { workspaceId: 'workspace-b' });
        const fixture = await createNativeRoomFixture([room, other]);
        fixture.facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-a' });
        const pending = fixture.facade.rtc[operation]('shared-room', { mode: 'warm', connect: false, timeoutMs: 1_000 });

        fixture.facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-b' });
        await fixture.lane.open();

        expect(await pending).toMatchObject({
            roomRef: { applicationId: 'app-1', workspaceId: 'workspace-a', groupId: 'shared-room' },
            rtc: { state: 'open', readyPeerIds: ['peer-a'] }
        });
    });
});

async function createNativeRoomFixture(snapshots: readonly GroupSnapshot[]): Promise<NativeRoomFixture> {
    const mocks = readRtcWaitMocks();
    mockGroupSnapshots(snapshots);
    const runtime = installNativeRtcRuntime();
    const fixture = createNativeRtcConnectionFixture(
        {
            sessionId: 'session-1',
            token: 'fixture-token',

            rtcSignalingTopicId: 'rtc',
            dataChannelName: 'reliable',
            iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 }
        },
        runtime,
        createPassThroughTransportFaultPort()
    );
    mocks.initialiseApiMiddleware.mockResolvedValue({
        ...mocks.ctx,
        middleware: { ...mocks.ctx.middleware, webRtcConnectionService: fixture.service }
    });
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();
    onTestFinished(async () => {
        try {
            await facade.disconnect();
        }
        finally {
            fixture.dispose();
            runtime.dispose();
        }
    });
    await facade.connect();
    fixture.service.ensurePeerConnectionStarted('peer-a', true);
    const peer = fixture.nativePeer('peer-a');
    const lane = peer.channels.find((channel) => channel.label === 'reliable');
    if (!lane) {
        throw new Error('Native reliable lane was not created');
    }
    return { facade, service: fixture.service, peer, lane, nativePeer: fixture.nativePeer };
}

function withoutPresence(snapshot: GroupSnapshot, sessionId: string): GroupSnapshot {
    const activeSessions = snapshot.activeSessions.filter((session) => session.sessionId !== sessionId);
    const presenceRevision = snapshot.causalRevision.presenceRevision + 1;
    return {
        ...snapshot,
        group: { ...snapshot.group, presenceVersion: presenceRevision },
        causalRevision: { ...snapshot.causalRevision, presenceRevision },
        activeSessions,
        onlineMemberCount: new Set(activeSessions.map((session) => session.principalId)).size
    };
}

function changeRoomAuthority(room: GroupSnapshot, change: 'halt' | 'local-departure' | 'peer-departure' | 'replacement'): void {
    const groupRevision = room.causalRevision.groupRevision + 1;
    if (change === 'halt') {
        mockGroupSnapshots([{
            ...room,
            group: { ...room.group, snapshotVersion: groupRevision, transportState: 'halted' },
            causalRevision: { ...room.causalRevision, groupRevision }
        }], [createAcceptedOverlay(room, ['peer-a'])]);
    }
    else if (change === 'local-departure' || change === 'peer-departure') {
        mockGroupSnapshots(
            [withoutPresence(room, change === 'local-departure' ? 'session-1' : 'peer-a')],
            [createAcceptedOverlay(room, ['peer-a'])]
        );
    }
    else {
        const replacement: GroupSnapshot = {
            ...room,
            group: {
                ...room.group,
                snapshotVersion: groupRevision,
                acceptedLayoutIdentity: { ...room.causalRevision, groupRevision, version: 2, state: 'active' }
            },
            causalRevision: { ...room.causalRevision, groupRevision }
        };
        mockGroupSnapshots([replacement]);
        mockAcceptedOverlay(replacement, ['peer-b']);
    }
}
