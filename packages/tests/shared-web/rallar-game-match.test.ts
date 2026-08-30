import type {
    RallarDirectorRelayConfig,
    RallarDirectorRelayHandle,
    RallarDirectorStatus,
    RallarRealtimeJsonSendInput,
    RallarRealtimeSendResult,
    RallarRoomRealtimeJsonDefaults,
    RallarRoomRealtimeJsonSendOptions,
    RallarRoomRealtimeSendResult,
    RallarRtcRoomLaneWaitOptions,
    RallarRtcRoomLaneWaitResult,
    RallarWsSendInput
} from '@shared-web/browser/rallar.ts';
import { createRallarGameEnvelope, createRallarGameMatch } from '@shared-web/game/mod.ts';
import type { RallarGameEnvelope, RallarGameMatchConfig, RallarGameRallarFacade } from '@shared-web/game/mod.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { describe, expect, it, vi } from 'vitest';

type Input = Readonly<{ x: number; }>;
type Intent = Readonly<{ action: string; }>;
type Snapshot = Readonly<{ tick: number; }>;
type Event = Readonly<{ kind: string; }>;

const roomRef: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
};

describe('Rallar Game match', () => {
    it('subscribes to expected Rallar surfaces on start', async () => {
        const fake = createFakeRallar();
        const match = createMatch(fake);

        await match.start();

        expect(fake.roomChangeHandlers).toHaveLength(1);
        expect(fake.peopleChangeHandlers).toHaveLength(1);
        expect(fake.directorStatusHandlers).toHaveLength(1);
        expect(fake.rtcStatusHandlers).toHaveLength(1);
        expect(fake.wsMessageHandlers).toHaveLength(1);
        expect(fake.realtimeJsonHandlers.get('game-input')).toHaveLength(1);
        expect(fake.realtimeJsonHandlers.get('game-snapshot')).toHaveLength(1);
        expect(fake.relayConfig).toMatchObject({
            laneId: 'game-intent',
            topicId: 'game.topic',
            intentTypeId: 'game.topic.intent.v1',
            outputTypeId: 'game.topic.event.v1',
            snapshotTypeId: 'game.topic.snapshot.v1',
            syncRequestTypeId: 'game.topic.sync-request.v1',
            heartbeatTypeId: 'game.topic.heartbeat.v1'
        });
    });

    it('sends capability reports as room-scoped WS messages', async () => {
        const fake = createFakeRallar();
        const match = createMatch(fake, {
            readCapability: () => ({
                fps: 60,
                hardwareConcurrency: 8
            })
        });
        await match.start();

        const result = await match.reportCapability({ scoreBias: 5 });

        expect(result).toMatchObject({ status: 'sent', transport: 'ws' });
        expect(fake.wsSend).toHaveBeenCalledWith(
            expect.objectContaining({
                topicId: 'game.topic',
                typeId: 'game.topic.capability.v1',
                scope: 'room',
                roomRef
            })
        );
        expect(fake.wsSend.mock.calls[0][0].payload).toMatchObject({
            protocol: 'test.game.v1',
            kind: 'capability',
            roomId: 'room-1',
            senderId: 'peer-a',
            payload: {
                peerId: 'peer-a',
                fps: 60,
                hardwareConcurrency: 8,
                scoreBias: 5
            }
        });
    });

    it('appoints the elected local peer as director', async () => {
        const fake = createFakeRallar({ localRole: 'owner' });
        const match = createMatch(fake, {
            readCapability: () => ({ scoreBias: 100 }),
            scoreHost: (capability) => capability.scoreBias ?? 0
        });
        await match.start();
        await match.reportCapability();

        const result = await match.appointIfElected();

        expect(result.status).toBe('appointed');
        expect(fake.appoint).toHaveBeenCalledWith(roomRef, {
            heartbeatTtlMs: 10_000
        });
        expect(match.status()).toMatchObject({
            phase: 'active',
            directorPeerId: 'peer-a',
            directorIsFresh: true
        });
    });

    it('marks a solo auto-appointed director as active with empty realtime egress', async () => {
        const fake = createFakeRallar({
            localRole: 'owner',
            remoteMemberKnown: false
        });
        fake.waitForRoomLane.mockResolvedValue({
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'game-snapshot',
            status: 'empty',
            rtcStatus: {
                sessionId: 'peer-a',
                laneId: 'game-snapshot',
                knownPeerIds: [],
                activePeerIds: [],
                peerIdsWithNoReconnectableLanes: [],
                readyPeerIds: [],
                peers: []
            },
            ready: [],
            notReady: [],
            readyPeerIds: [],
            notReadyPeerIds: [],
            missingPeerIds: [],
            extraPeerIds: [],
            observedCount: 0,
            expectedCount: 0
        });
        const match = createMatch(fake, {
            readCapability: () => ({ scoreBias: 100 }),
            scoreHost: (capability) => capability.scoreBias ?? 0
        });

        await match.start();
        await match.reportCapability();
        await match.appointIfElected();
        await match.waitForReadyLanes({
            laneIds: ['game-snapshot'],
            expect: { exact: 0 },
            timeoutMs: 10
        });

        expect(match.status()).toMatchObject({
            directorPeerId: 'peer-a',
            directorIsFresh: true,
            directorAuthority: 'active',
            egress: {
                reliable: 'ready',
                realtime: 'empty'
            }
        });
        expect(match.diagnostics()).toMatchObject({
            directorAuthority: 'active',
            egress: {
                reliable: 'ready',
                realtime: 'empty'
            }
        });
    });

    it('keeps local director authority active while remote realtime lanes warm', async () => {
        const fake = createFakeRallar({ localRole: 'owner' });
        fake.waitForRoomLane.mockResolvedValue({
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'game-snapshot',
            status: 'timeout',
            rtcStatus: {
                sessionId: 'peer-a',
                laneId: 'game-snapshot',
                knownPeerIds: ['peer-b'],
                activePeerIds: ['peer-b'],
                peerIdsWithNoReconnectableLanes: [],
                readyPeerIds: [],
                peers: []
            },
            ready: [],
            notReady: [],
            readyPeerIds: [],
            notReadyPeerIds: ['peer-b'],
            missingPeerIds: [],
            extraPeerIds: [],
            observedCount: 0,
            expectedCount: 1
        });
        const match = createMatch(fake, {
            readCapability: () => ({ scoreBias: 100 }),
            scoreHost: (capability) => capability.scoreBias ?? 0
        });

        await match.start();
        await match.reportCapability();
        await match.appointIfElected();
        await match.waitForReadyLanes({
            laneIds: ['game-snapshot'],
            expect: { exact: 1 },
            timeoutMs: 1
        });

        expect(match.status()).toMatchObject({
            directorAuthority: 'active',
            egress: {
                reliable: 'ready',
                realtime: 'timeout'
            }
        });
    });

    it('allows the elected active member to appoint when owners are offline by default', async () => {
        const fake = createFakeRallar({
            localRole: 'member',
            remoteMemberKnown: false
        });
        const match = createMatch(fake, {
            readCapability: () => ({ scoreBias: 100 }),
            scoreHost: (capability) => capability.scoreBias ?? 0
        });
        await match.start();
        await match.reportCapability();

        expect(match.canAppointDirector()).toMatchObject({
            allowed: true,
            status: 'allowed',
            localRole: 'member'
        });

        const result = await match.appointIfElected();

        expect(result.status).toBe('appointed');
        expect(fake.appoint).toHaveBeenCalledWith(roomRef, {
            heartbeatTtlMs: 10_000
        });
    });

    it('does not appoint a non-admin local peer with the strict metadata-backed policy', async () => {
        const fake = createFakeRallar({ localRole: 'member' });
        fake.failOnAppointment();
        const match = createMatch(fake, {
            directorAppointmentPolicy: 'metadata-owner-admin',
            readCapability: () => ({ scoreBias: 100 }),
            scoreHost: (capability) => capability.scoreBias ?? 0
        });
        await match.start();
        await match.reportCapability();

        const result = await match.appointIfElected();

        expect(result.status).toBe('not-authorized');
        expect(result.reason).toBe('Only active room owners/admins can appoint the browser director.');
        expect(match.canAppointDirector()).toMatchObject({
            allowed: false,
            status: 'not-authorized'
        });
        expect(match.diagnostics()).toMatchObject({
            appointment: expect.objectContaining({
                status: 'not-authorized',
                localRole: 'member'
            })
        });
        expect(match.diagnostics().issues).toContain('director-not-authorized');
    });

    it('does not use member fallback while another director appointment is active', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-b',
            directorIsFresh: true,
            localRole: 'member',
            remoteMemberKnown: false
        });
        fake.failOnAppointment();
        const match = createMatch(fake, {
            readCapability: () => ({ scoreBias: 100 }),
            scoreHost: (capability) => capability.scoreBias ?? 0
        });
        await match.start();
        await match.reportCapability();

        const result = await match.appointIfElected();

        expect(result.status).toBe('not-authorized');
        expect(result.reason).toBe(
            'Cannot appoint a fallback director while another director is active.'
        );
        expect(match.canAppointDirector()).toMatchObject({
            allowed: false,
            status: 'not-authorized',
            localRole: 'member'
        });
    });

    it('does not use member fallback until the local session is active', async () => {
        const fake = createFakeRallar({
            localRole: 'member',
            localSessionIds: [],
            remoteMemberKnown: false
        });
        fake.failOnAppointment();
        const match = createMatch(fake, {
            readCapability: () => ({ scoreBias: 100 }),
            scoreHost: (capability) => capability.scoreBias ?? 0
        });
        await match.start();
        await match.reportCapability();

        const result = await match.appointIfElected();

        expect(result.status).toBe('not-authorized');
        expect(result.reason).toBe(
            'Only active room members can appoint the browser director.'
        );
    });

    it('waits for local membership before metadata-backed director appointment', async () => {
        const fake = createFakeRallar({ localMemberKnown: false });
        fake.failOnAppointment();
        const match = createMatch(fake, {
            readCapability: () => ({ scoreBias: 100 }),
            scoreHost: (capability) => capability.scoreBias ?? 0
        });
        await match.start();
        await match.reportCapability();

        const result = await match.appointIfElected();

        expect(result.status).toBe('not-ready');
        expect(result.reason).toBe('Cannot confirm local room membership yet.');
        expect(match.diagnostics().issues).toContain('director-eligibility-not-ready');
    });

    it('does not appoint a non-elected local peer', async () => {
        const fake = createFakeRallar({ localRole: 'owner' });
        fake.failOnAppointment();
        const match = createMatch(fake, {
            readCapability: () => ({ scoreBias: 1 }),
            scoreHost: (capability) => capability.scoreBias ?? 0
        });
        await match.start();
        await match.reportCapability();
        await fake.emitCapability({
            peerId: 'peer-b',
            reportedAtEpochMs: Date.now(),
            scoreBias: 50
        });

        const result = await match.appointIfElected();

        expect(result.status).toBe('not-elected');
    });

    it('publishes presence over realtime room scope with replace-by-key defaults', async () => {
        const fake = createFakeRallar();
        const match = createMatch(fake);
        await match.start();

        const result = await match.sendPresence({ x: 7 });

        expect(result).toMatchObject({ status: 'sent', transport: 'realtime' });
        expect(fake.realtimeSendJson).toHaveBeenCalledWith(expect.objectContaining({
            laneId: 'game-input',
            roomRef,
            data: expect.objectContaining({
                kind: 'presence',
                payload: { x: 7 },
                senderId: 'peer-a'
            }),
            key: 'presence:peer-a',
            maxAgeMs: 250,
            openTimeoutMs: 500
        }));
    });

    it('keeps the room facade as the only presence send owner when no target is ready', async () => {
        const fake = createFakeRallar();
        fake.setRoomRealtimeSendResult({
            transport: 'rtc',
            status: 'no-targets',
            laneId: 'game-input',
            roomRef,
            peerIds: [],
            desiredPeerIds: ['peer-b'],
            results: [],
            reason: 'Room RTC has no ready peers.'
        });
        const match = createMatch(fake);
        await match.start();

        const result = await match.sendPresence({ x: 7 });

        expect(result).toMatchObject({ status: 'not-ready', transport: 'realtime' });
        expect(fake.roomRealtimeSendCount).toBe(1);
        expect(fake.realtimeSendCount).toBe(0);
    });

    it('delivers peer presence envelopes to subscribers', async () => {
        const fake = createFakeRallar();
        const receivedPresence: RallarGameEnvelope<Input>[] = [];
        const match = createMatch(fake, {
            onPresence: (presence) => {
                receivedPresence.push(presence);
            }
        });
        await match.start();

        await fake.emitRealtime(
            'game-input',
            'peer-b',
            envelope('presence', 'peer-b', { x: 4 }, 51)
        );

        expect(receivedPresence).toHaveLength(1);
        expect(receivedPresence[0]).toMatchObject({
            senderId: 'peer-b',
            payload: { x: 4 }
        });
    });

    it('sends input only to a fresh director', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-b',
            directorIsFresh: true
        });
        const match = createMatch(fake);
        await match.start();

        expect(await match.sendInput({ x: 1 })).toMatchObject({
            status: 'sent',
            transport: 'realtime'
        });
        expect(fake.realtimeSendJson).toHaveBeenCalledWith(
            expect.objectContaining({
                laneId: 'game-input',
                peerIds: ['peer-b'],
                key: 'input:peer-a'
            })
        );

        fake.setDirector('peer-b', false);
        expect(await match.sendInput({ x: 2 })).toMatchObject({
            status: 'no-director'
        });
        expect(fake.realtimeSendCount).toBe(1);
    });

    it('rejects snapshots that do not come from the fresh director', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-b',
            directorIsFresh: true
        });
        const receivedSnapshots: RallarGameEnvelope<Snapshot>[] = [];
        const match = createMatch(fake, {
            onSnapshot: (snapshot) => {
                receivedSnapshots.push(snapshot);
            }
        });
        await match.start();

        await fake.emitRealtime(
            'game-snapshot',
            'peer-c',
            envelope('snapshot', 'peer-c', { tick: 1 }, 1)
        );
        await fake.emitRealtime(
            'game-snapshot',
            'peer-b',
            envelope('snapshot', 'peer-b', { tick: 2 }, 2)
        );

        expect(receivedSnapshots).toHaveLength(1);
        expect(receivedSnapshots[0].payload).toEqual({ tick: 2 });
    });

    it('rejects realtime input from a different match identity', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-a',
            directorIsFresh: true
        });
        const receivedInputs: RallarGameEnvelope<Input>[] = [];
        const match = createMatch(fake, {
            matchId: 'match-b',
            onInput: (input) => {
                receivedInputs.push(input);
            }
        });
        await match.start();

        await fake.emitRealtime(
            'game-input',
            'peer-b',
            envelope('input', 'peer-b', { x: 4 }, 1, 'match-a')
        );

        expect(receivedInputs).toEqual([]);
    });

    it('rejects relay snapshots from a different match identity', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-a',
            directorIsFresh: true
        });
        const receivedSnapshots: RallarGameEnvelope<Snapshot>[] = [];
        const match = createMatch(fake, {
            matchId: 'match-b',
            onSnapshot: (snapshot) => {
                receivedSnapshots.push(snapshot);
            }
        });
        await match.start();

        await emitRelaySnapshot(fake, 'match-a');

        expect(receivedSnapshots).toEqual([]);
    });

    it('rejects realtime input without a configured match identity', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-a',
            directorIsFresh: true
        });
        const receivedInputs: RallarGameEnvelope<Input>[] = [];
        const match = createMatch(fake, {
            matchId: 'match-b',
            onInput: (input) => {
                receivedInputs.push(input);
            }
        });
        await match.start();

        await fake.emitRealtime(
            'game-input',
            'peer-b',
            envelope('input', 'peer-b', { x: 4 }, 1)
        );

        expect(receivedInputs).toEqual([]);
    });

    it('rejects relay snapshots without a configured match identity', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-a',
            directorIsFresh: true
        });
        const receivedSnapshots: RallarGameEnvelope<Snapshot>[] = [];
        const match = createMatch(fake, {
            matchId: 'match-b',
            onSnapshot: (snapshot) => {
                receivedSnapshots.push(snapshot);
            }
        });
        await match.start();

        await emitRelaySnapshot(fake);

        expect(receivedSnapshots).toEqual([]);
    });

    it('delegates sync request to Director Relay and exposes readSnapshot for relay sync responses', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-b',
            directorIsFresh: true
        });
        const match = createMatch(fake, {
            readSnapshot: () => ({ tick: 99 })
        });
        await match.start();

        await match.requestSync({ reason: 'join-late' });

        expect(fake.relay.requestSync).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'sync-request',
                payload: { reason: 'join-late' }
            })
        );

        fake.setDirector('peer-a', true);
        const snapshot = await fake.relayConfig?.readSnapshot?.();
        expect(snapshot).toMatchObject({
            kind: 'snapshot',
            senderId: 'peer-a',
            payload: { tick: 99 }
        });
    });

    it('sets recovery status when the director is stale', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-b',
            directorIsFresh: false
        });
        const match = createMatch(fake);

        await match.start();

        expect(match.status()).toMatchObject({
            phase: 'recovering',
            directorPeerId: 'peer-b',
            directorIsFresh: false,
            recovery: {
                status: 'recovering',
                reason: 'No fresh director is available.'
            }
        });

        fake.setDirector('peer-b', true);
        await fake.emitDirectorStatus();
        expect(match.status()).toMatchObject({
            phase: 'active',
            directorIsFresh: true,
            recovery: { status: 'idle' }
        });
    });

    it('stops subscriptions and prevents later handler calls', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-b',
            directorIsFresh: true
        });
        const receivedSnapshots: RallarGameEnvelope<Snapshot>[] = [];
        const match = createMatch(fake, {
            onSnapshot: (snapshot) => {
                receivedSnapshots.push(snapshot);
            }
        });
        await match.start();

        match.stop();
        await fake.emitRealtime(
            'game-snapshot',
            'peer-b',
            envelope('snapshot', 'peer-b', { tick: 1 }, 1)
        );

        expect(match.status()).toMatchObject({
            phase: 'stopped',
            stopped: true
        });
        expect(receivedSnapshots).toEqual([]);
        expect(fake.relayStopped).toBe(true);
    });

    it('returns stopped for network methods after stop without touching transports', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-a',
            directorIsFresh: true
        });
        const match = createMatch(fake, {
            readSnapshot: () => ({ tick: 99 })
        });
        await match.start();
        match.stop();
        fake.createRelay.mockImplementation(() => {
            throw new Error('A stopped match cannot create a relay.');
        });
        vi.mocked(fake.relay.sendIntent).mockImplementation(() => {
            throw new Error('A stopped match cannot send an intent.');
        });
        vi.mocked(fake.relay.sendOutput).mockImplementation(() => {
            throw new Error('A stopped match cannot send an output.');
        });
        vi.mocked(fake.relay.sendSnapshot).mockImplementation(() => {
            throw new Error('A stopped match cannot send a snapshot.');
        });
        vi.mocked(fake.relay.requestSync).mockImplementation(() => {
            throw new Error('A stopped match cannot request sync.');
        });
        fake.realtimeSendJson.mockImplementation(() => {
            throw new Error('A stopped match cannot send realtime data.');
        });
        fake.wsSend.mockImplementation(() => {
            throw new Error('A stopped match cannot send websocket data.');
        });
        fake.waitForRoomLane.mockImplementation(() => {
            throw new Error('A stopped match cannot wait for room lanes.');
        });

        const sendResults = await Promise.all([
            match.sendInput({ x: 1 }),
            match.sendIntent({ action: 'dash' }),
            match.publishSnapshot({ tick: 2 }),
            match.publishEvent({ kind: 'hit' }),
            match.requestSync({ reason: 'late-join' }),
            match.sendPresence({ x: 3 })
        ]);
        const readiness = await match.waitForReadyLanes();

        expect(sendResults).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ status: 'stopped' })
            ])
        );
        expect(sendResults.every((result) => result.status === 'stopped')).toBe(true);
        expect(readiness).toMatchObject({
            status: 'aborted',
            reason: 'Rallar Game match is stopped.'
        });
    });
});

function createMatch(
    fake: ReturnType<typeof createFakeRallar>,
    overrides: Partial<RallarGameMatchConfig<Input, Intent, Snapshot, Event>> = {}
) {
    return createRallarGameMatch<Input, Intent, Snapshot, Event>({
        rallar: fake.rallar,
        protocol: 'test.game.v1',
        topicId: 'game.topic',
        ...overrides
    });
}

function envelope<T>(
    kind: RallarGameEnvelope<T>['kind'],
    senderId: string,
    payload: T,
    seq: number,
    matchId?: string
): RallarGameEnvelope<T> {
    return createRallarGameEnvelope({
        protocol: 'test.game.v1',
        kind,
        roomId: 'room-1',
        matchId,
        senderId,
        seq,
        directorEpoch: 1,
        sentAtEpochMs: 1_000 + seq,
        payload
    });
}

async function emitRelaySnapshot(
    fake: ReturnType<typeof createFakeRallar>,
    matchId?: string
): Promise<void> {
    const snapshot = envelope(
        'snapshot',
        'peer-a',
        { tick: 1 },
        2,
        matchId
    );
    await fake.relayConfig?.onSnapshot?.({
        transport: 'rtc',
        senderId: 'peer-a',
        data: snapshot,
        envelope: {
            protocol: 'rallar.director.relay.v1',
            topicId: 'game.topic',
            typeId: 'game.topic.snapshot.v1',
            roomId: 'room-1',
            epoch: 1,
            sentAtEpochMs: 1_002,
            payload: snapshot
        },
        receivedAtEpochMs: 1_003
    });
}

interface FakeRallarOptions {
    readonly directorPeerId?: string;
    readonly directorIsFresh?: boolean;
    readonly localRole?: 'owner' | 'admin' | 'member';
    readonly localStatus?: 'active' | 'left' | 'removed' | 'banned' | 'invited';
    readonly localSessionIds?: readonly string[];
    readonly localMemberKnown?: boolean;
    readonly remoteMemberKnown?: boolean;
}

interface FakeRallarRoomMember {
    readonly principalId: string;
    readonly username: string;
    readonly role: 'owner' | 'admin' | 'member';
    readonly status: 'active' | 'left' | 'removed' | 'banned' | 'invited';
    readonly isOwner: boolean;
    readonly isOnline: boolean;
    readonly sessionIds: readonly string[];
}

interface FakeRallarRoomState {
    readonly rooms: readonly never[];
    readonly currentRoomId: string;
    readonly currentRoomRef: GroupRef;
    readonly members: readonly FakeRallarRoomMember[];
}

interface FakeRallarState {
    directorStatus: RallarDirectorStatus;
    relayConfig:
        | RallarDirectorRelayConfig<RallarGameEnvelope<Intent>, RallarGameEnvelope<Event>, RallarGameEnvelope<Snapshot>>
        | undefined;
    relayStopped: boolean;
    realtimeSendCount: number;
    roomRealtimeSendCount: number;
    appointmentMustFail: boolean;
    roomRealtimeSendResult: RallarRoomRealtimeSendResult | undefined;
}

interface FakeRallarAssembly {
    readonly handlers: ReturnType<typeof createFakeRallarHandlers>;
    readonly session: ReturnType<typeof createFakeRallarSession>;
    readonly roomState: FakeRallarRoomState;
    readonly state: FakeRallarState;
    readonly relayPorts: ReturnType<typeof createFakeRelayPorts>;
    readonly realtimePorts: ReturnType<typeof createFakeRealtimePorts>;
    readonly waitPorts: ReturnType<typeof createFakeWaitPorts>;
    readonly wsSend: ReturnType<typeof createFakeWsSend>;
}

interface EmitFakeRealtimeInput {
    readonly assembly: FakeRallarAssembly;
    readonly laneId: string;
    readonly peerId: string;
    readonly data: object;
}

function createFakeRallar(options: FakeRallarOptions = {}) {
    const handlers = createFakeRallarHandlers();
    const session = createFakeRallarSession();
    const roomState = createFakeRallarRoomState(options);
    const state = createFakeRallarState(options);
    const relayPorts = createFakeRelayPorts(state);
    const realtimePorts = createFakeRealtimePorts(state);
    const waitPorts = createFakeWaitPorts(session, roomState);
    const wsSend = createFakeWsSend();
    const assembly = { handlers, session, roomState, state, relayPorts, realtimePorts, waitPorts, wsSend };
    return {
        ...handlers,
        ...relayPorts,
        ...realtimePorts,
        ...waitPorts,
        wsSend,
        failOnAppointment: () => {
            state.appointmentMustFail = true;
        },
        get relayStopped() {
            return state.relayStopped;
        },
        get realtimeSendCount() {
            return state.realtimeSendCount;
        },
        get roomRealtimeSendCount() {
            return state.roomRealtimeSendCount;
        },
        get relayConfig() {
            return state.relayConfig;
        },
        rallar: createFakeRallarFacade(assembly),
        setDirector(peerId: string | undefined, isFresh: boolean) {
            state.directorStatus = createDirectorStatus(peerId, isFresh);
        },
        setRoomRealtimeSendResult(result: RallarRoomRealtimeSendResult | undefined) {
            state.roomRealtimeSendResult = result;
        },
        emitDirectorStatus: () => emitFakeDirectorStatus(assembly),
        emitCapability: (capability: Readonly<{ peerId: string; reportedAtEpochMs: number; scoreBias?: number; }>) => emitFakeCapability(assembly, capability),
        emitRealtime: (laneId: string, peerId: string, data: object) => emitFakeRealtime({ assembly, laneId, peerId, data })
    };
}

function createFakeRallarHandlers() {
    return {
        roomChangeHandlers: [] as Array<(state: object) => void | Promise<void>>,
        peopleChangeHandlers: [] as Array<(state: object) => void | Promise<void>>,
        directorStatusHandlers: [] as Array<(status: RallarDirectorStatus) => void | Promise<void>>,
        rtcStatusHandlers: [] as Array<(status: object) => void | Promise<void>>,
        wsMessageHandlers: [] as Array<(message: object) => void | Promise<void>>,
        realtimeJsonHandlers: new Map<string, Array<(message: { peerId: string; data: object; }) => void | Promise<void>>>()
    };
}

function createFakeRallarSession() {
    return {
        clientId: 'principal-a',
        sessionId: 'peer-a',
        username: 'alice',
        accessToken: 'token',
        expiresAtEpochMs: Date.now() + 60_000
    };
}

function createFakeRallarRoomState(options: FakeRallarOptions): FakeRallarRoomState {
    const localMember: FakeRallarRoomMember = {
        principalId: 'principal-a',
        username: 'alice',
        role: options.localRole ?? 'owner',
        status: options.localStatus ?? 'active',
        isOwner: (options.localRole ?? 'owner') === 'owner',
        isOnline: (options.localSessionIds ?? ['peer-a']).length > 0,
        sessionIds: options.localSessionIds ?? ['peer-a']
    };
    const remoteMember: FakeRallarRoomMember = {
        principalId: 'principal-b',
        username: 'bob',
        role: 'member',
        status: 'active',
        isOwner: false,
        isOnline: true,
        sessionIds: ['peer-b']
    };
    return {
        rooms: [],
        currentRoomId: 'room-1',
        currentRoomRef: roomRef,
        members: [
            ...(options.localMemberKnown === false ? [] : [localMember]),
            ...(options.remoteMemberKnown === false ? [] : [remoteMember])
        ]
    };
}

function createFakeRallarState(options: FakeRallarOptions): FakeRallarState {
    return {
        directorStatus: createDirectorStatus(options.directorPeerId, options.directorIsFresh ?? false),
        relayConfig: undefined,
        relayStopped: false,
        realtimeSendCount: 0,
        roomRealtimeSendCount: 0,
        appointmentMustFail: false,
        roomRealtimeSendResult: undefined
    };
}

function createFakeRelayPorts(state: FakeRallarState) {
    const relay: RallarDirectorRelayHandle<RallarGameEnvelope<Intent>, RallarGameEnvelope<Event>, RallarGameEnvelope<Snapshot>> = {
        status: () => state.directorStatus,
        sendIntent: vi.fn(async () => ({ status: 'sent' as const })),
        sendOutput: vi.fn(async () => ({ status: 'sent' as const })),
        sendHeartbeat: vi.fn(async () => ({ status: 'sent' as const })),
        sendSnapshot: vi.fn(async () => ({ status: 'sent' as const })),
        requestSync: vi.fn(async () => ({ status: 'sent' as const })),
        stop: vi.fn(() => {
            state.relayStopped = true;
        })
    };
    const createRelay = vi.fn((config: FakeRallarState['relayConfig']) => {
        state.relayConfig = config;
        return relay;
    });
    const appoint = vi.fn(async () => {
        if (state.appointmentMustFail) {
            throw new Error('Appointment was forbidden by this test.');
        }
        state.directorStatus = createDirectorStatus('peer-a', true);
        return state.directorStatus;
    });
    return { relay, createRelay, appoint };
}

function createFakeWsSend() {
    return vi.fn(async (input: RallarWsSendInput<object>) => ({
        transport: 'ws' as const,
        status: 'enqueued' as const,
        message: input,
        entries: []
    }));
}

function createFakeRealtimePorts(state: FakeRallarState) {
    const realtimeSendJson = vi.fn(
        async (
            input: RallarRealtimeJsonSendInput<object>
        ): Promise<readonly RallarRealtimeSendResult[]> => {
            state.realtimeSendCount += 1;
            return (input.peerIds ?? ['peer-b']).map((peerId) => ({
                peerId,
                laneId: input.laneId ?? 'realtime',
                result: { status: 'sent' as const, bufferedAmount: 0 }
            }));
        }
    );
    const roomRealtimeSend = vi.fn(async (
        defaults: RallarRoomRealtimeJsonDefaults,
        data: object,
        options: RallarRoomRealtimeJsonSendOptions<object> = {}
    ): Promise<RallarRoomRealtimeSendResult> => {
        state.roomRealtimeSendCount += 1;
        if (state.roomRealtimeSendResult) {
            return state.roomRealtimeSendResult;
        }
        const results = await realtimeSendJson({ ...defaults, ...options, data });
        return {
            transport: 'rtc' as const,
            status: 'sent' as const,
            laneId: defaults.laneId ?? 'realtime',
            roomId: defaults.roomId,
            roomRef: defaults.roomRef,
            peerIds: results.map((result) => result.peerId),
            desiredPeerIds: results.map((result) => result.peerId),
            results
        };
    });
    return { realtimeSendJson, roomRealtimeSend };
}

function createFakeWaitPorts(
    session: ReturnType<typeof createFakeRallarSession>,
    roomState: FakeRallarRoomState
) {
    const waitForRoomLane = vi.fn(async (
        _room: string | GroupRef,
        laneId: string,
        _options?: RallarRtcRoomLaneWaitOptions
    ): Promise<RallarRtcRoomLaneWaitResult> => ({
        transport: 'rtc' as const,
        roomId: 'room-1',
        laneId,
        status: 'open' as const,
        rtcStatus: {
            sessionId: session.sessionId,
            laneId,
            knownPeerIds: ['peer-b'],
            activePeerIds: ['peer-b'],
            peerIdsWithNoReconnectableLanes: [],
            readyPeerIds: ['peer-b'],
            peers: []
        },
        ready: [],
        notReady: [],
        readyPeerIds: ['peer-b'],
        notReadyPeerIds: [],
        missingPeerIds: [],
        extraPeerIds: [],
        observedCount: 1,
        expectedCount: 1
    }));
    const waitForPresence = vi.fn(async () => ({
        status: 'ready' as const,
        roomId: 'room-1',
        roomRef,
        activeSessionIds: roomState.members.flatMap((member) => member.sessionIds),
        observedSessionIds: roomState.members.flatMap((member) => member.sessionIds),
        missingSessionIds: [],
        extraSessionIds: [],
        observedCount: roomState.members.flatMap((member) => member.sessionIds).length,
        expectedCount: 1,
        timedOut: false
    }));
    return { waitForRoomLane, waitForPresence };
}

function createFakeRallarFacade(input: FakeRallarAssembly): RallarGameRallarFacade {
    return {
        session: () => input.session,
        subscriptions: createSubscriptionScope,
        rooms: createFakeRoomsFacade(input),
        people: createFakePeopleFacade(input),
        director: createFakeDirectorFacade(input),
        rtc: createFakeRtcFacade(input),
        realtime: createFakeRealtimeFacade(input),
        messages: createFakeMessagesFacade(input),
        ws: createFakeWsFacade(input)
    };
}

function createFakeRoomsFacade(input: FakeRallarAssembly): RallarGameRallarFacade['rooms'] {
    return createPartialTestDouble<RallarGameRallarFacade['rooms']>({
        state: () => input.roomState,
        waitForPresence: input.waitPorts.waitForPresence,
        onChange: (handler: (state: object) => void | Promise<void>) => {
            input.handlers.roomChangeHandlers.push(handler);
            return () => remove(input.handlers.roomChangeHandlers, handler);
        }
    });
}

function createFakePeopleFacade(input: FakeRallarAssembly): RallarGameRallarFacade['people'] {
    return createPartialTestDouble<RallarGameRallarFacade['people']>({
        state: () => ({ people: [], clients: [] }),
        onChange: (handler: (state: object) => void | Promise<void>) => {
            input.handlers.peopleChangeHandlers.push(handler);
            return () => remove(input.handlers.peopleChangeHandlers, handler);
        }
    });
}

function createFakeDirectorFacade(input: FakeRallarAssembly): RallarGameRallarFacade['director'] {
    return createPartialTestDouble<RallarGameRallarFacade['director']>({
        status: () => input.state.directorStatus,
        onStatus: (handler: (status: RallarDirectorStatus) => void | Promise<void>) => {
            input.handlers.directorStatusHandlers.push(handler);
            return () => remove(input.handlers.directorStatusHandlers, handler);
        },
        appoint: input.relayPorts.appoint,
        createRelay: input.relayPorts.createRelay
    });
}

function createFakeRtcFacade(input: FakeRallarAssembly): RallarGameRallarFacade['rtc'] {
    return createPartialTestDouble<RallarGameRallarFacade['rtc']>({
        status: () => ({
            sessionId: input.session.sessionId,
            laneId: 'game-input',
            knownPeerIds: ['peer-b'],
            activePeerIds: ['peer-b'],
            peerIdsWithNoReconnectableLanes: [],
            readyPeerIds: ['peer-b'],
            peers: []
        }),
        onStatus: (handler: (status: object) => void | Promise<void>) => {
            input.handlers.rtcStatusHandlers.push(handler);
            return () => remove(input.handlers.rtcStatusHandlers, handler);
        },
        waitForRoomLane: input.waitPorts.waitForRoomLane
    });
}

function createFakeRealtimeFacade(input: FakeRallarAssembly): RallarGameRallarFacade['realtime'] {
    return createPartialTestDouble<RallarGameRallarFacade['realtime']>({
        sendJson: input.realtimePorts.realtimeSendJson,
        room: (defaults: RallarRoomRealtimeJsonDefaults) => ({
            send: async (data: object, options: RallarRoomRealtimeJsonSendOptions<object> = {}) =>
                await input.realtimePorts.roomRealtimeSend(defaults, data, options),
            on: (handler: (message: { peerId: string; data: object; }) => void | Promise<void>) =>
                subscribeFakeRealtime(input, defaults.laneId ?? 'realtime', handler),
            status: () => ({ rtc: { state: 'open' as const } }),
            wait: async () => ({ rtc: { state: 'open' as const } })
        }),
        onJson: (
            laneId: string,
            handler: (message: { peerId: string; data: object; }) => void | Promise<void>
        ) => subscribeFakeRealtime(input, laneId, handler),
        health: () => []
    });
}

function subscribeFakeRealtime(
    input: FakeRallarAssembly,
    laneId: string,
    handler: (message: { peerId: string; data: object; }) => void | Promise<void>
): () => void {
    const handlers = input.handlers.realtimeJsonHandlers.get(laneId) ?? [];
    handlers.push(handler);
    input.handlers.realtimeJsonHandlers.set(laneId, handlers);
    return () => remove(handlers, handler);
}

function createFakeMessagesFacade(input: FakeRallarAssembly): RallarGameRallarFacade['messages'] {
    return createPartialTestDouble<RallarGameRallarFacade['messages']>({
        ws: {
            send: input.wsSend,
            onMessage: (_selector: object | string, handler: (message: object) => void | Promise<void>) => {
                input.handlers.wsMessageHandlers.push(handler);
                return () => remove(input.handlers.wsMessageHandlers, handler);
            }
        }
    });
}

function createFakeWsFacade(input: FakeRallarAssembly): RallarGameRallarFacade['ws'] {
    const status = () => ({
        sessionId: input.session.sessionId,
        connectState: 'connected' as const,
        readyState: 'open' as const,
        isOpen: true,
        reconnecting: false,
        reconnectEnabled: true,
        reconnectAttempts: 0,
        maxReconnectAttempts: 5,
        reconnectExhausted: false
    });
    return {
        status,
        onStatus: () => () => undefined,
        onLifecycle: () => () => undefined,
        waitForOpen: async () => ({
            transport: 'ws',
            status: 'open',
            wsStatus: status()
        })
    };
}

async function emitFakeDirectorStatus(input: FakeRallarAssembly): Promise<void> {
    await Promise.all(
        input.handlers.directorStatusHandlers.map((handler) => handler(input.state.directorStatus))
    );
}

async function emitFakeCapability(
    input: FakeRallarAssembly,
    capability: Readonly<{ peerId: string; reportedAtEpochMs: number; scoreBias?: number; }>
): Promise<void> {
    const message = {
        senderId: capability.peerId,
        payload: envelope('capability', capability.peerId, capability, 100)
    };
    await Promise.all(input.handlers.wsMessageHandlers.map((handler) => handler(message)));
}

async function emitFakeRealtime(input: EmitFakeRealtimeInput): Promise<void> {
    const handlers = input.assembly.handlers.realtimeJsonHandlers.get(input.laneId) ?? [];
    await Promise.all(handlers.map((handler) => handler({ peerId: input.peerId, data: input.data })));
}

function createDirectorStatus(
    directorPeerId: string | undefined,
    isFresh: boolean
): RallarDirectorStatus {
    const appointment = directorPeerId
        ? {
            version: 1 as const,
            mode: 'appointed-spa' as const,
            sessionId: directorPeerId,
            principalId: directorPeerId === 'peer-a'
                ? 'principal-a'
                : 'principal-b',
            epoch: 1,
            appointedAtEpochMs: 1_000,
            heartbeatTtlMs: 10_000
        }
        : undefined;

    return {
        roomId: 'room-1',
        roomRef,
        role: !appointment
            ? 'none'
            : directorPeerId === 'peer-a'
            ? 'director'
            : 'client',
        state: !appointment ? 'none' : isFresh ? 'fresh' : 'stale',
        appointment,
        isDirector: directorPeerId === 'peer-a',
        isFresh,
        active: Boolean(appointment),
        freshness: !appointment ? 'none' : isFresh ? 'fresh' : 'stale',
        nowEpochMs: Date.now()
    };
}

function createSubscriptionScope() {
    const unsubscribes: Array<() => void> = [];
    return {
        add(unsubscribe?: (() => void) | null) {
            if (unsubscribe) {
                unsubscribes.push(unsubscribe);
            }
            return this;
        },
        unsubscribe() {
            while (unsubscribes.length > 0) {
                unsubscribes.pop()?.();
            }
        },
        size() {
            return unsubscribes.length;
        }
    };
}

function remove<T>(values: T[], value: T): void {
    const index = values.indexOf(value);
    if (index >= 0) {
        values.splice(index, 1);
    }
}

function createPartialTestDouble<T extends object>(implementation: object): T {
    return implementation as T;
}
