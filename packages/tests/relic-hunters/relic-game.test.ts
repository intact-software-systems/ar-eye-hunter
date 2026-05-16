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

    it('maps resolved turn events to scene animation cues', () => {
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
        const cueByEventType = new Map(
            result.state.events.map((event) => [event.type, event.animationCue?.type]),
        );

        expect(cueByEventType.get('action_revealed')).toBe('noise_pulse');
        expect(cueByEventType.get('player_searched')).toBe('search_altar');
        expect(cueByEventType.get('player_moved')).toBe('camera_move');
        expect(cueByEventType.get('noise_pulse')).toBe('noise_pulse');
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

    it('rejects non-admin expedition starts', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = applyRelicCommand(state, join('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 2,
        }).state;
        state = applyRelicCommand(state, join('bob', 'Bob'), {
            senderId: 'bob',
            now: () => 3,
        }).state;

        expect(() =>
            applyRelicCommand(state, start('bob', 'Bob'), {
                senderId: 'bob',
                now: () => 4,
            })
        ).toThrow('Only the administrator can start the expedition.');
        expect(state.phase).toBe('lobby');
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

    it('marks empty room searches as durable room investigations', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = applyRelicCommand(state, join('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 2,
        }).state;
        state = applyRelicCommand(state, start('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 3,
        }).state;

        state = applyRelicCommand(
            state,
            submit('alice', 'Alice', { kind: 'search' }),
            {
                senderId: 'alice',
                now: () => 4,
            },
        ).state;

        expect(state.roomInvestigations).toHaveLength(1);
        expect(state.roomInvestigations[0]).toMatchObject({
            roomId: 'entrance',
            searchedByPlayerId: 'alice',
            searchedByUsername: 'Alice',
            searchedAtRound: 1,
            searchedAtEpochMs: 4,
            result: 'empty',
            summary: 'Entrance was searched clear.',
            hint: 'Move toward a stronger clue or the Exit.',
            effect: 'ordinary-search',
            revealedRoomId: 'storage',
        });
        expect(toPublicRelicSnapshot(state).roomInvestigations).toEqual(state.roomInvestigations);
    });

    it('adds room-specific notes to empty investigations', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = {
            ...state,
            relics: state.relics.filter((relic) => relic.roomId !== 'storage'),
        };
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

        expect(state.roomInvestigations).toContainEqual(expect.objectContaining({
            roomId: 'storage',
            result: 'empty',
            summary: 'The crates held a torn supply map, but no relic.',
            hint: 'The supply marks point back toward the Entrance and onward through the Trap Room.',
            effect: 'map-fragment',
            revealedRoomId: 'trap',
        }));
    });

    it('marks relic discoveries as durable room investigations', () => {
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

        expect(state.roomInvestigations).toContainEqual({
            roomId: 'storage',
            searchedByPlayerId: 'alice',
            searchedByUsername: 'Alice',
            searchedAtRound: 2,
            searchedAtEpochMs: 5,
            result: 'relic-found',
            summary: 'Sun Disk was recovered here.',
            hint: 'Carry the relic toward the Exit before the castle closes.',
            effect: 'map-fragment',
            revealedRoomId: 'trap',
            relicId: 'sun-disk',
        });
    });

    it('softens repeated searches in already investigated rooms', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = applyRelicCommand(state, join('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 2,
        }).state;
        state = applyRelicCommand(state, start('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 3,
        }).state;

        state = applyRelicCommand(
            state,
            submit('alice', 'Alice', { kind: 'search' }),
            {
                senderId: 'alice',
                now: () => 4,
            },
        ).state;
        state = applyRelicCommand(
            state,
            submit('alice', 'Alice', { kind: 'search' }),
            {
                senderId: 'alice',
                now: () => 5,
            },
        ).state;

        expect(state.roomInvestigations).toHaveLength(1);
        expect(state.events.at(-3)?.message).toContain('useful clues were already marked');
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
