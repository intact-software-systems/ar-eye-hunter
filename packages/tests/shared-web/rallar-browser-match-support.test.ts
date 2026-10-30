import { createRallarFacade, type RallarDirectorRelayHandle, type RallarDirectorStatus, type RallarWsStatus } from '@shared-web/browser/rallar.ts';
import {
    createRallarBrowserMatch,
    createRallarGameMatch,
    type RallarGameMatchHandle,
    type RallarGameMatchStatus,
    type RallarGameRallarFacade,
    type RallarGameSendResult
} from '@shared-web/game/mod.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { describe, expect, it, vi } from 'vitest';
import { createGameRoomStateFixture } from './rallar-game-room-state-fixture.ts';

interface Command {
    readonly kind: 'move';
    readonly x: number;
}
interface Snapshot {
    readonly tick: number;
}
interface Event {
    readonly kind: 'accepted';
}

const roomRef: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

describe('Rallar browser match support', () => {
    it('creates a browser-director match from the Rallar Game match helper', async () => {
        const game = fakeGameMatch();
        const createGameMatch = vi.fn(() => game);
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar: fakeRallarFacade(),
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1',
            readSnapshot: () => ({ tick: 1 })
        }, {
            createGameMatch,
            nowEpochMs: () => 2_000,
            resultId: () => 'result-1'
        });

        await expect(match.start()).resolves.toMatchObject({ phase: 'active', protocol: 'example.match.v1' });

        expect(createGameMatch).toHaveBeenCalledWith(
            expect.objectContaining({
                protocol: 'example.match.v1',
                topicId: 'room.example.match'
            })
        );
    });

    it('submits commands through the intent lane', async () => {
        const game = fakeGameMatch();
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar: fakeRallarFacade(),
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1'
        }, {
            createGameMatch: () => game
        });

        await expect(match.submitCommand({ kind: 'move', x: 3 })).resolves
            .toEqual({ status: 'sent', transport: 'local' });
        expect(game.sendIntent).toHaveBeenCalledWith({ kind: 'move', x: 3 });
    });

    it('sends command envelopes with the browser match identity', async () => {
        const onCommand = vi.fn();
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar: fakeRallarFacade(),
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1',
            onCommand
        });
        await match.start();
        try {
            await match.submitCommand({ kind: 'move', x: 3 });
            expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
                kind: 'intent',
                matchId: 'match-1',
                payload: { kind: 'move', x: 3 }
            }));
        }
        finally {
            match.stop();
        }
    });

    it('derives standings with the app-provided comparator', () => {
        const game = fakeGameMatch();
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar: fakeRallarFacade(),
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1',
            readStandingRows: () => [
                {
                    participantId: 'principal-a',
                    principalId: 'principal-a',
                    sessionIds: ['session-a'],
                    metrics: { points: 20, objectives: 1 }
                },
                {
                    participantId: 'principal-b',
                    principalId: 'principal-b',
                    sessionIds: ['session-b'],
                    metrics: { points: 10, objectives: 2 }
                }
            ],
            compareStandings: (left, right) => right.metrics.objectives - left.metrics.objectives
        }, {
            createGameMatch: () => game
        });

        expect(match.standings()).toMatchObject([
            { participantId: 'principal-b', rank: 1 },
            { participantId: 'principal-a', rank: 2 }
        ]);
    });

    it('finalizes from the fresh local director appointment and app comparator', () => {
        const game = fakeGameMatch();
        const rallar = fakeRallarFacade();
        const directorStatus = vi.spyOn(rallar.director, 'status');
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar,
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1',
            readStandingRows: () => [
                {
                    participantId: 'principal-a',
                    principalId: 'principal-a',
                    sessionIds: ['session-a'],
                    metrics: { points: 20, objectives: 1 }
                },
                {
                    participantId: 'principal-b',
                    principalId: 'principal-b',
                    sessionIds: ['session-b'],
                    metrics: { points: 10, objectives: 2 }
                }
            ],
            compareStandings: (left, right) => right.metrics.objectives - left.metrics.objectives
        }, {
            createGameMatch: () => game,
            nowEpochMs: () => 2_000,
            resultId: () => 'result-1'
        });

        expect(match.finalizeResult({ reason: 'complete' })).toMatchObject({
            resultId: 'result-1',
            matchId: 'match-1',
            trust: 'room-trusted',
            protocol: 'example.match.v1',
            authority: {
                kind: 'browser-director',
                id: 'session-a',
                epoch: 4,
                principalId: 'principal-a',
                sessionId: 'session-a'
            },
            summary: { reason: 'complete' },
            standings: [
                { participantId: 'principal-b', rank: 1 },
                { participantId: 'principal-a', rank: 2 }
            ]
        });
        expect(directorStatus).toHaveBeenCalledWith({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        });
    });

    it('rejects finalization when the live director appointment is missing', () => {
        const rallar = fakeRallarFacade();
        const current = rallar.director.status();
        vi.spyOn(rallar.director, 'status').mockReturnValue({
            ...current,
            role: 'none',
            state: 'none',
            appointment: undefined,
            isDirector: false,
            isFresh: false,
            active: false,
            freshness: 'none'
        });
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar,
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1'
        }, {
            createGameMatch: () => fakeGameMatch()
        });

        expect(() => match.finalizeResult({ reason: 'complete' })).toThrow(
            'Cannot finalize a room-trusted Rallar match result without a fresh director appointment.'
        );
    });

    it('rejects finalization when the live director appointment is stale', () => {
        const rallar = fakeRallarFacade();
        const current = rallar.director.status();
        vi.spyOn(rallar.director, 'status').mockReturnValue({
            ...current,
            state: 'stale',
            isFresh: false,
            freshness: 'stale'
        });
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar,
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1'
        }, {
            createGameMatch: () => fakeGameMatch()
        });

        expect(() => match.finalizeResult({ reason: 'complete' })).toThrow(
            'Cannot finalize a room-trusted Rallar match result without a fresh director appointment.'
        );
    });

    it('rejects finalization when another session holds the live appointment', () => {
        const rallar = fakeRallarFacade();
        const current = rallar.director.status();
        if (!current.appointment) {
            throw new Error('The fixture must appoint the local director before replacing it.');
        }
        vi.spyOn(rallar.director, 'status').mockReturnValue({
            ...current,
            role: 'client',
            isDirector: false,
            appointment: {
                ...current.appointment,
                principalId: 'principal-b',
                sessionId: 'session-b'
            }
        });
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar,
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1'
        }, {
            createGameMatch: () => fakeGameMatch()
        });

        expect(() => match.finalizeResult({ reason: 'complete' })).toThrow(
            'Cannot finalize a room-trusted Rallar match result unless the local session holds the director appointment.'
        );
    });

    it('throws when no status, config, or current-room GroupRef exists', () => {
        const game = fakeGameMatch();
        vi.mocked(game.status).mockReturnValue({
            ...game.status(),
            roomRef: undefined
        });
        const rallar = fakeRallarFacade();
        vi.spyOn(rallar.rooms, 'state').mockReturnValue({
            ...rallar.rooms.state(),
            currentRoomRef: undefined
        });
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar,
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1'
        }, {
            createGameMatch: () => game
        });

        expect(() => match.finalizeResult({ reason: 'complete' })).toThrow(
            'Cannot finalize a Rallar match result without a roomRef.'
        );
    });
});

function fakeGameMatch(): RallarGameMatchHandle<Command, Command, Snapshot, Event, Command> {
    const game = createRallarGameMatch<Command, Command, Snapshot, Event, Command>({
        rallar: fakeRallarFacade(),
        protocol: 'example.match.v1',
        topicId: 'room.example.match'
    });
    const status: RallarGameMatchStatus = {
        phase: 'active',
        protocol: 'example.match.v1',
        topicId: 'room.example.match',
        roomId: 'room-1',
        roomRef,
        localPeerId: 'session-a',
        directorPeerId: 'session-a',
        directorEpoch: 4,
        directorIsFresh: true,
        directorAuthority: 'active',
        egress: { reliable: 'ready', realtime: 'ready' },
        recovery: { status: 'idle' },
        started: true,
        stopped: false,
        updatedAtEpochMs: 1_000
    };
    return {
        ...game,
        start: vi.fn(async () => status),
        status: vi.fn(() => status),
        sendIntent: vi.fn(async (): Promise<RallarGameSendResult> => ({ status: 'sent', transport: 'local' }))
    };
}

function fakeRallarFacade(): RallarGameRallarFacade {
    const base = createRallarFacade();
    const roomState = createGameRoomStateFixture(roomRef, [{
        principalId: 'principal-a',
        username: 'Ada',
        role: 'owner',
        status: 'active',
        isOwner: true,
        isOnline: true,
        sessionIds: ['session-a'],
        topicGrants: {}
    }]);
    return {
        ...base,
        session: () => ({
            clientId: 'principal-a',
            sessionId: 'session-a',
            username: 'Ada',
            accessToken: 'token',
            expiresAtEpochMs: Date.now() + 60_000
        }),
        rooms: { ...base.rooms, state: () => roomState, onChange: () => () => undefined },
        people: { ...base.people, state: () => ({ people: [], clients: [] }), onChange: () => () => undefined },
        director: {
            ...base.director,
            status: fakeDirectorStatus,
            onStatus: () => () => undefined,
            createRelay: fakeDirectorRelay
        },
        rtc: {
            ...base.rtc,
            status: () => ({
                sessionId: 'session-a',
                laneId: 'game-input',
                knownPeerIds: [],
                activePeerIds: [],
                peerIdsWithNoReconnectableLanes: [],
                readyPeerIds: [],
                peers: []
            }),
            onStatus: () => () => undefined
        },
        realtime: { ...base.realtime, onJson: () => () => undefined },
        messages: {
            ...base.messages,
            ws: { ...base.messages.ws, onMessage: () => () => undefined },
            rtc: { ...base.messages.rtc, onMessage: () => () => undefined }
        },
        ws: { ...base.ws, status: connectedWsStatus }
    };
}

function fakeDirectorStatus(): RallarDirectorStatus {
    return {
        roomId: 'room-1',
        roomRef,
        role: 'director',
        state: 'fresh',
        isDirector: true,
        isFresh: true,
        appointment: {
            version: 1,
            mode: 'appointed-spa',
            sessionId: 'session-a',
            principalId: 'principal-a',
            epoch: 4,
            appointedAtEpochMs: 1_000,
            heartbeatTtlMs: 5_000
        },
        active: true,
        freshness: 'fresh',
        nowEpochMs: 2_000
    };
}

function fakeDirectorRelay<TIntent, TOutput, TSnapshot>(): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot> {
    return {
        status: fakeDirectorStatus,
        sendIntent: async () => ({ status: 'sent' }),
        sendOutput: async () => ({ status: 'sent' }),
        sendHeartbeat: async () => ({ status: 'sent' }),
        sendSnapshot: async () => ({ status: 'sent' }),
        requestSync: async () => ({ status: 'sent' }),
        stop: () => undefined
    };
}

function connectedWsStatus(): RallarWsStatus {
    return {
        connectState: 'connected',
        readyState: 'open',
        isOpen: true,
        reconnecting: false,
        reconnectEnabled: true,
        reconnectAttempts: 0,
        maxReconnectAttempts: 5,
        reconnectExhausted: false
    };
}
