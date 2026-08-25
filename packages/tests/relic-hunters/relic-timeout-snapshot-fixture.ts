import {
    applyRelicCommand,
    createRelicGame,
    RELIC_PROTOCOL_VERSION,
    toPublicRelicSnapshot,
    type RelicGameState,
    type RelicPublicSnapshot
} from '@relic-hunters/mod.ts';

export interface TimedOutRoundSnapshots {
    readonly timedOut: RelicPublicSnapshot;
    readonly resolved: RelicPublicSnapshot;
}

export function createTimedOutRoundSnapshots(): TimedOutRoundSnapshots {
    const now = Date.now();
    const roundStartedAt = now - 90_000;
    const state = submitAliceTimeoutAction(
        createStartedTimeoutRound(roundStartedAt),
        roundStartedAt + 1
    );
    return {
        timedOut: toPublicRelicSnapshot(state),
        resolved: toPublicRelicSnapshot(
            applyRelicCommand(state, {
                protocolVersion: RELIC_PROTOCOL_VERSION,
                kind: 'force-resolve-round',
                gameId: 'room-1',
                username: 'Alice'
            }, {
                senderId: 'alice-session',
                now: () => now
            }).state
        )
    };
}

function createStartedTimeoutRound(roundStartedAt: number): RelicGameState {
    let state = createRelicGame('room-1', 'room-1', roundStartedAt - 5);
    state = applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username: 'Alice',
        characterId: 'kael-ironstride'
    }, {
        senderId: 'alice-session',
        now: () => roundStartedAt - 4
    }).state;
    state = applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username: 'Bob',
        characterId: 'nyra-vale'
    }, {
        senderId: 'bob-session',
        now: () => roundStartedAt - 3
    }).state;
    return applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'start-expedition',
        gameId: 'room-1',
        username: 'Alice'
    }, {
        senderId: 'alice-session',
        now: () => roundStartedAt
    }).state;
}

function submitAliceTimeoutAction(
    state: RelicGameState,
    now: number
): RelicGameState {
    return applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'submit-action',
        gameId: 'room-1',
        username: 'Alice',
        action: { kind: 'move', targetRoomId: 'hallway' }
    }, {
        senderId: 'alice-session',
        now: () => now
    }).state;
}
