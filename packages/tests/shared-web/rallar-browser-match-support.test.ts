import { createRallarBrowserMatch, type RallarBrowserMatchDependencies } from '@shared-web/game/mod.ts';
import type { RallarGameMatchConfig, RallarGameMatchHandle, RallarGameMatchStatus } from '@shared-web/game/mod.ts';
import { describe, expect, it, vi } from 'vitest';

type Command = Readonly<{ kind: 'move'; x: number; }>;
type Snapshot = Readonly<{ tick: number; }>;
type Event = Readonly<{ kind: 'accepted'; }>;

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

        await match.start();

        expect(createGameMatch).toHaveBeenCalledWith(
            expect.objectContaining({
                protocol: 'example.match.v1',
                topicId: 'room.example.match'
            })
        );
        expect(game.start).toHaveBeenCalledOnce();
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

        await match.submitCommand({ kind: 'move', x: 3 });

        expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'intent',
            matchId: 'match-1',
            payload: { kind: 'move', x: 3 }
        }));
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
        vi.spyOn(rallar.director, 'status').mockReturnValue({
            ...current,
            role: 'client',
            isDirector: false,
            appointment: {
                ...current.appointment!,
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
    const status: RallarGameMatchStatus = {
        phase: 'active',
        protocol: 'example.match.v1',
        topicId: 'room.example.match',
        roomId: 'room-1',
        roomRef: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        },
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
        start: vi.fn(async () => status),
        stop: vi.fn(),
        status: vi.fn(() => status),
        diagnostics: vi.fn(() => ({
            generatedAtEpochMs: 1_000,
            phase: 'active',
            roomId: 'room-1',
            localPeerId: 'session-a',
            directorPeerId: 'session-a',
            directorEpoch: 4,
            directorIsFresh: true,
            directorAuthority: 'active',
            egress: { reliable: 'ready', realtime: 'ready' },
            recovery: { status: 'idle' },
            knownPeerIds: [],
            readyPeerIds: [],
            notReadyPeerIds: [],
            capabilityCount: 0,
            rtcPeerCount: 0,
            realtimeHealth: [],
            issues: []
        })),
        canAppointDirector: vi.fn(),
        reportCapability: vi.fn(),
        election: vi.fn(),
        appointIfElected: vi.fn(),
        waitForReadyLanes: vi.fn(),
        sendInput: vi.fn(),
        sendPresence: vi.fn(),
        sendIntent: vi.fn(async () => ({ status: 'sent', transport: 'local' })),
        publishSnapshot: vi.fn(),
        publishEvent: vi.fn(),
        requestSync: vi.fn(),
        onPresence: vi.fn(() => () => undefined),
        onStatus: vi.fn(() => () => undefined)
    } as RallarGameMatchHandle<Command, Command, Snapshot, Event, Command>;
}

function fakeRallarFacade(): RallarGameMatchConfig<Command, Command, Snapshot, Event, Command>['rallar'] {
    return {
        session: () => ({
            clientId: 'principal-a',
            sessionId: 'session-a',
            username: 'Ada',
            token: 'token',
            issuedAtEpochMs: 1,
            expiresAtEpochMs: 10_000
        }),
        subscriptions: () => ({
            add() {
                return this;
            },
            unsubscribe() {
                return undefined;
            }
        }),
        rooms: {
            state: () => ({
                rooms: [],
                currentRoomId: 'room-1',
                currentRoomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
                members: [
                    {
                        principalId: 'principal-a',
                        username: 'Ada',
                        role: 'owner',
                        status: 'active',
                        isOwner: true,
                        isOnline: true,
                        sessionIds: ['session-a']
                    }
                ]
            }),
            onChange: () => () => undefined
        },
        people: {
            state: () => ({ people: [] }),
            onChange: () => () => undefined
        },
        director: {
            status: () => ({
                roomId: 'room-1',
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
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
            }),
            appoint: vi.fn(),
            resign: vi.fn(),
            onStatus: () => () => undefined,
            createRelay: vi.fn()
        },
        rtc: {
            status: () => ({
                sessionId: 'session-a',
                laneId: 'game-input',
                knownPeerIds: [],
                activePeerIds: [],
                peerIdsWithNoReconnectableLanes: [],
                readyPeerIds: [],
                peers: []
            }),
            onStatus: () => () => undefined,
            waitForRoomLane: vi.fn()
        },
        realtime: {
            sendJson: vi.fn(),
            onJson: () => () => undefined,
            health: () => [],
            room: vi.fn()
        },
        messages: {
            ws: {
                send: vi.fn(),
                onMessage: () => () => undefined
            },
            rtc: {
                onMessage: () => () => undefined
            },
            room: vi.fn()
        },
        ws: {
            status: () => ({
                connectState: 'connected',
                readyState: 'open',
                isOpen: true,
                reconnecting: false,
                reconnectEnabled: true,
                reconnectAttempts: 0,
                maxReconnectAttempts: 5,
                reconnectExhausted: false
            })
        }
    } as unknown as RallarGameMatchConfig<Command, Command, Snapshot, Event, Command>['rallar'];
}
