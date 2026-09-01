import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import type { RallarFacade } from '@shared-web/browser/rallar-facade-contract.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';

import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime,
    type SimulatedNativeRtcDataChannel,
    type SimulatedNativeRtcPeerConnection
} from '../../shared/native-rtc-connection-fixture.ts';
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

describe('room RTC authority and native progress', () => {
    beforeEach(resetRtcWaitTestRuntime);

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
    const fixture = createNativeRtcConnectionFixture({
        sessionId: 'session-1',
        token: 'fixture-token',
        rtcSignalingTopicId: 'rtc',
        dataChannelName: 'reliable',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 }
    }, runtime);
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
