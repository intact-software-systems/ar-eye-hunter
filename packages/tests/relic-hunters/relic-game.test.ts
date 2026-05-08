import { describe, expect, it } from 'vitest';
import {
    RELIC_PROTOCOL_VERSION,
    type RelicCommand,
    applyRelicCommand,
    createRelicGame,
    toPublicRelicSnapshot,
} from '@relic-hunters/mod.ts';

describe('Relic Hunters game rules', () => {
    it('keeps submitted actions hidden until all active hunters have acted', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = applyRelicCommand(state, join('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 2,
        }).state;
        state = applyRelicCommand(state, join('bob', 'Bob'), {
            senderId: 'bob',
            now: () => 3,
        }).state;
        state = applyRelicCommand(state, start('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 4,
        }).state;

        const afterAlice = applyRelicCommand(
            state,
            submit('alice', 'Alice', { kind: 'search' }),
            {
                senderId: 'alice',
                now: () => 5,
            },
        );
        const snapshot = toPublicRelicSnapshot(afterAlice.state);

        expect(afterAlice.resolvedRound).toBe(false);
        expect(snapshot.submittedPlayerIds).toEqual(['alice']);
        expect(JSON.stringify(snapshot)).not.toContain('search');
    });

    it('resolves a round after every active hunter submits', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = applyRelicCommand(state, join('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 2,
        }).state;
        state = applyRelicCommand(state, join('bob', 'Bob'), {
            senderId: 'bob',
            now: () => 3,
        }).state;
        state = applyRelicCommand(state, start('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 4,
        }).state;
        state = applyRelicCommand(
            state,
            submit('alice', 'Alice', { kind: 'search' }),
            {
                senderId: 'alice',
                now: () => 5,
            },
        ).state;
        const result = applyRelicCommand(
            state,
            submit('bob', 'Bob', { kind: 'move', targetRoomId: 'hallway' }),
            {
                senderId: 'bob',
                now: () => 6,
            },
        );

        expect(result.resolvedRound).toBe(true);
        expect(result.state.round).toBe(2);
        expect(result.state.pendingActions).toEqual([]);
        expect(result.state.players.find((player) => player.playerId === 'bob')?.roomId)
            .toBe('hallway');
    });

    it('lets a hunter update their locked plan before the round resolves', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = applyRelicCommand(state, join('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 2,
        }).state;
        state = applyRelicCommand(state, join('bob', 'Bob'), {
            senderId: 'bob',
            now: () => 3,
        }).state;
        state = applyRelicCommand(state, start('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 4,
        }).state;
        state = applyRelicCommand(
            state,
            submit('alice', 'Alice', { kind: 'move', targetRoomId: 'storage' }),
            {
                senderId: 'alice',
                now: () => 5,
            },
        ).state;
        state = applyRelicCommand(
            state,
            submit('alice', 'Alice', { kind: 'move', targetRoomId: 'hallway' }),
            {
                senderId: 'alice',
                now: () => 6,
            },
        ).state;

        const result = applyRelicCommand(
            state,
            submit('bob', 'Bob', { kind: 'search' }),
            {
                senderId: 'bob',
                now: () => 7,
            },
        );

        expect(result.resolvedRound).toBe(true);
        expect(result.state.pendingActions).toEqual([]);
        expect(result.state.players.find((player) => player.playerId === 'alice')?.roomId)
            .toBe('hallway');
    });

    it('rejects late joins after the expedition has started', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = applyRelicCommand(state, join('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 2,
        }).state;
        state = applyRelicCommand(state, start('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 3,
        }).state;

        expect(() =>
            applyRelicCommand(state, join('bob', 'Bob'), {
                senderId: 'bob',
                now: () => 4,
            })
        ).toThrow('Cannot join an expedition after it has started.');
    });

    it('rejects non-adjacent move submissions before they enter the pending plan', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = applyRelicCommand(state, join('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 2,
        }).state;
        state = applyRelicCommand(state, start('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 3,
        }).state;

        expect(() =>
            applyRelicCommand(
                state,
                submit('alice', 'Alice', { kind: 'move', targetRoomId: 'exit' }),
                {
                    senderId: 'alice',
                    now: () => 4,
                },
            )
        ).toThrow('Move target is not adjacent.');
        expect(state.pendingActions).toEqual([]);
    });

    it('scores found relics and escape bonus when a hunter exits safely', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = applyRelicCommand(state, join('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 2,
        }).state;
        state = applyRelicCommand(state, start('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 3,
        }).state;

        for (const [index, action] of ([
            { kind: 'move', targetRoomId: 'storage' },
            { kind: 'search' },
            { kind: 'move', targetRoomId: 'entrance' },
            { kind: 'move', targetRoomId: 'hallway' },
            { kind: 'move', targetRoomId: 'trap' },
            { kind: 'move', targetRoomId: 'monster' },
            { kind: 'move', targetRoomId: 'exit' },
            { kind: 'escape' },
        ] as const).entries()) {
            state = applyRelicCommand(
                state,
                submit('alice', 'Alice', action),
                {
                    senderId: 'alice',
                    now: () => 4 + index,
                },
            ).state;
        }

        const alice = state.players.find((player) => player.playerId === 'alice');
        expect(state.phase).toBe('finished');
        expect(alice).toMatchObject({
            escaped: true,
            score: 11,
            relicIds: [],
        });
        expect(state.relics.find((relic) => relic.id === 'sun-disk')).toMatchObject({
            foundBy: 'alice',
            escapedBy: 'alice',
        });
        expect(state.winnerIds).toEqual(['alice']);
    });
});

function join(playerId: string, username: string): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username,
    };
}

function start(playerId: string, username: string): RelicCommand {
    void playerId;
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'start-expedition',
        gameId: 'room-1',
        username,
    };
}

function submit(
    playerId: string,
    username: string,
    action: Extract<RelicCommand, { kind: 'submit-action' }>['action'],
): RelicCommand {
    void playerId;
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'submit-action',
        gameId: 'room-1',
        username,
        action,
    };
}
