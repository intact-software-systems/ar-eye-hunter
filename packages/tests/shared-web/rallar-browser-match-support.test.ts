import { describe, expect, it, vi } from 'vitest';
import {
    createRallarBrowserMatch,
    type RallarBrowserMatchDependencies,
} from '@shared-web/game/mod.ts';
import type {
    RallarGameMatchConfig,
    RallarGameMatchHandle,
    RallarGameMatchStatus,
} from '@shared-web/game/mod.ts';

type Command = Readonly<{ kind: 'move'; x: number }>;
type Snapshot = Readonly<{ tick: number }>;
type Event = Readonly<{ kind: 'accepted' }>;

describe('Rallar browser match support', () => {
    it('creates a browser-director match from the Rallar Game match helper', async () => {
        const game = fakeGameMatch();
        const createGameMatch = vi.fn(() => game);
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar: fakeRallarFacade(),
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1',
            readSnapshot: () => ({ tick: 1 }),
        }, {
            createGameMatch,
            nowEpochMs: () => 2_000,
            resultId: () => 'result-1',
        });

        await match.start();

        expect(createGameMatch).toHaveBeenCalledWith(
            expect.objectContaining({
                protocol: 'example.match.v1',
                topicId: 'room.example.match',
            }),
        );
        expect(game.start).toHaveBeenCalledOnce();
    });

    it('submits commands through the intent lane', async () => {
        const game = fakeGameMatch();
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar: fakeRallarFacade(),
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1',
        }, {
            createGameMatch: () => game,
        });

        await expect(match.submitCommand({ kind: 'move', x: 3 })).resolves
            .toEqual({ status: 'sent', transport: 'local' });
        expect(game.sendIntent).toHaveBeenCalledWith({ kind: 'move', x: 3 });
    });

    it('derives participants and standings from app-provided metrics', () => {
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
                    metrics: { points: 20 },
                },
                {
                    participantId: 'principal-b',
                    principalId: 'principal-b',
                    sessionIds: ['session-b'],
                    metrics: { points: 10 },
                },
            ],
        }, {
            createGameMatch: () => game,
        });

        expect(match.standings()).toMatchObject([
            { participantId: 'principal-a', rank: 1 },
            { participantId: 'principal-b', rank: 2 },
        ]);
    });

    it('finalizes a room-trusted result for browser-director matches', () => {
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
                    metrics: { points: 20 },
                },
            ],
        }, {
            createGameMatch: () => game,
            nowEpochMs: () => 2_000,
            resultId: () => 'result-1',
        });

        expect(match.finalizeResult({ reason: 'complete' })).toMatchObject({
            resultId: 'result-1',
            matchId: 'match-1',
            trust: 'room-trusted',
            protocol: 'example.match.v1',
            summary: { reason: 'complete' },
            standings: [{ participantId: 'principal-a', rank: 1 }],
        });
    });

    it('throws when no status, config, or current-room GroupRef exists', () => {
        const game = fakeGameMatch();
        vi.mocked(game.status).mockReturnValue({
            ...game.status(),
            roomRef: undefined,
        });
        const rallar = fakeRallarFacade();
        vi.spyOn(rallar.rooms, 'state').mockReturnValue({
            ...rallar.rooms.state(),
            currentRoomRef: undefined,
        });
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar,
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1',
        }, {
            createGameMatch: () => game,
        });

        expect(() => match.finalizeResult({ reason: 'complete' })).toThrow(
            'Cannot finalize a Rallar match result without a roomRef.',
        );
    });
});

function fakeGameMatch(): RallarGameMatchHandle<
    Command,
    Command,
    Snapshot,
    Event,
    Command
> {
    const status: RallarGameMatchStatus = {
        phase: 'active',
        protocol: 'example.match.v1',
        topicId: 'room.example.match',
        roomId: 'room-1',
        roomRef: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
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
        updatedAtEpochMs: 1_000,
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
            issues: [],
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
        onStatus: vi.fn(() => () => undefined),
    } as RallarGameMatchHandle<Command, Command, Snapshot, Event, Command>;
}

function fakeRallarFacade(): RallarGameMatchConfig<
    Command,
    Command,
    Snapshot,
    Event,
    Command
>['rallar'] {
    return {
        session: () => ({
            clientId: 'principal-a',
            sessionId: 'session-a',
            username: 'Ada',
            token: 'token',
            issuedAtEpochMs: 1,
            expiresAtEpochMs: 10_000,
        }),
        subscriptions: () => ({
            add() {
                return this;
            },
            unsubscribe() {
                return undefined;
            },
        }),
        rooms: {
            state: () => ({
                rooms: [],
                currentRoomId: 'room-1',
                currentRoomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                },
                members: [
                    {
                        principalId: 'principal-a',
                        username: 'Ada',
                        role: 'owner',
                        status: 'active',
                        isOwner: true,
                        isOnline: true,
                        sessionIds: ['session-a'],
                    },
                ],
            }),
            onChange: () => () => undefined,
        },
        people: {
            state: () => ({ people: [] }),
            onChange: () => () => undefined,
        },
        director: {
            status: () => ({
                roomId: 'room-1',
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                },
                isDirector: true,
                isFresh: true,
                appointment: {
                    version: 1,
                    mode: 'appointed-spa',
                    sessionId: 'session-a',
                    principalId: 'principal-a',
                    epoch: 4,
                    appointedAtEpochMs: 1_000,
                    heartbeatTtlMs: 5_000,
                },
                freshness: 'fresh',
            }),
            appoint: vi.fn(),
            resign: vi.fn(),
            onStatus: () => () => undefined,
            createRelay: vi.fn(),
        },
        rtc: {
            status: () => ({
                sessionId: 'session-a',
                laneId: 'game-input',
                knownPeerIds: [],
                activePeerIds: [],
                peerIdsWithNoReconnectableLanes: [],
                readyPeerIds: [],
                peers: [],
            }),
            onStatus: () => () => undefined,
            waitForRoomLane: vi.fn(),
        },
        realtime: {
            sendJson: vi.fn(),
            onJson: () => () => undefined,
            health: () => [],
            room: vi.fn(),
        },
        messages: {
            ws: {
                send: vi.fn(),
                onMessage: () => () => undefined,
            },
            rtc: {
                onMessage: () => () => undefined,
            },
            room: vi.fn(),
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
                reconnectExhausted: false,
            }),
        },
    } as RallarGameMatchConfig<Command, Command, Snapshot, Event, Command>['rallar'];
}
