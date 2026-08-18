import { describe, expect, it } from 'vitest';
import {
    RELIC_PROTOCOL_VERSION,
    type RelicCommand,
    type RelicGameState,
    type RelicPublicSnapshot,
    applyRelicCommand,
    createProceduralRelicExpeditionBlueprint,
    createRelicGame,
    createRelicGameFromBlueprint,
    isRelicSnapshot,
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
        expect(result.state.round).toBe(1);
        expect(result.state.phase).toBe('review');
        expect(result.state.pendingActions).toEqual([]);
        expect(result.state.players.find((player) => player.playerId === 'bob')?.roomId)
            .toBe('hallway');

        const continued = continueReview(result.state, 7);
        expect(continued.round).toBe(2);
        expect(continued.phase).toBe('planning');
    });

    it('lets an active hunter force-resolve after the round timer expires', () => {
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
            submit('alice', 'Alice', { kind: 'move', targetRoomId: 'hallway' }),
            {
                senderId: 'alice',
                now: () => 5,
            },
        ).state;

        const result = applyRelicCommand(state, forceResolve('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 65_000,
        });

        expect(result.resolvedRound).toBe(true);
        expect(result.state.round).toBe(1);
        expect(result.state.phase).toBe('review');
        expect(result.state.pendingActions).toEqual([]);
        expect(result.state.players.find((player) => player.playerId === 'alice')?.roomId)
            .toBe('hallway');
        expect(result.state.players.find((player) => player.playerId === 'bob')?.roomId)
            .toBe('entrance');
        expect(result.state.events.some((event) =>
            event.message.includes('Missing plans skipped: Bob')
        )).toBe(true);

        const continued = continueReview(result.state, 65_500);
        expect(continued.round).toBe(2);
        expect(continued.phase).toBe('planning');
    });

    it('rejects force-resolve before the round timer expires', () => {
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

        expect(() =>
            applyRelicCommand(state, forceResolve('alice', 'Alice'), {
                senderId: 'alice',
                now: () => 10,
            })
        ).toThrow('Round timer has not expired.');
        expect(state.round).toBe(1);
    });

    it('maps resolved turn events to scene animation cues', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = {
            ...state,
            relics: state.relics.filter((relic) => relic.roomId !== 'entrance'),
        };
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
        expect(result.state.events.find((event) => event.type === 'player_moved')?.animationCue)
            .toMatchObject({
                fromRoomId: 'entrance',
                roomId: 'hallway',
            });
    });

    it('lets an active hunter instantly pick up a visible same-room relic', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = applyRelicCommand(state, join('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 2,
        }).state;
        state = applyRelicCommand(state, start('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 3,
        }).state;

        const result = applyRelicCommand(state, pickup('alice', 'Alice', 'visitor-badge'), {
            senderId: 'alice',
            now: () => 4,
        });
        const alice = result.state.players.find((player) => player.playerId === 'alice');

        expect(result.resolvedRound).toBe(false);
        expect(result.state.phase).toBe('planning');
        expect(alice?.relicIds).toContain('visitor-badge');
        expect(alice?.score).toBeGreaterThan(0);
        expect(result.state.relics.find((relic) => relic.id === 'visitor-badge')).toMatchObject({
            foundBy: 'alice',
            carriedBy: 'alice',
        });
        expect(result.state.events.at(-1)).toMatchObject({
            type: 'relic_picked_up',
            animationCue: {
                type: 'relic_pickup',
                playerId: 'alice',
                roomId: 'entrance',
                relicId: 'visitor-badge',
            },
        });
    });

    it('rejects instant pickup when the relic is unavailable or in another room', () => {
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
            applyRelicCommand(state, pickup('alice', 'Alice', 'sun-disk'), {
                senderId: 'alice',
                now: () => 4,
            })
        ).toThrow('Relic is not in this hunter\'s room.');

        state = applyRelicCommand(state, pickup('alice', 'Alice', 'visitor-badge'), {
            senderId: 'alice',
            now: () => 5,
        }).state;

        expect(() =>
            applyRelicCommand(state, pickup('alice', 'Alice', 'visitor-badge'), {
                senderId: 'alice',
                now: () => 6,
            })
        ).toThrow('Relic has already been claimed.');
    });

    it('rejects instant pickup during review', () => {
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
            submit('alice', 'Alice', { kind: 'move', targetRoomId: 'hallway' }),
            {
                senderId: 'alice',
                now: () => 4,
            },
        ).state;

        expect(state.phase).toBe('review');
        expect(() =>
            applyRelicCommand(state, pickup('alice', 'Alice', 'copper-coin'), {
                senderId: 'alice',
                now: () => 5,
            })
        ).toThrow('Review the revealed actions before planning the next turn.');
    });

    it('allows only the expedition administrator to continue review', () => {
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
        state = applyRelicCommand(
            state,
            submit('bob', 'Bob', { kind: 'move', targetRoomId: 'hallway' }),
            {
                senderId: 'bob',
                now: () => 6,
            },
        ).state;

        expect(() =>
            applyRelicCommand(state, {
                protocolVersion: RELIC_PROTOCOL_VERSION,
                kind: 'continue-review',
                gameId: 'room-1',
                username: 'Bob',
            }, {
                senderId: 'bob',
                now: () => 7,
            })
        ).toThrow('Only the administrator can continue the review.');
        expect(continueReview(state, 8).phase).toBe('planning');
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
        state = {
            ...state,
            relics: state.relics.filter((relic) => relic.roomId !== 'entrance'),
        };
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

    it('redacts undiscovered relic identity, value, and location from public snapshots', () => {
        const state = createRelicGame('room-1', 'room-1', 1);
        const snapshot = toPublicRelicSnapshot(state);
        expect(snapshot.relics).toHaveLength(state.relics.length);
        expect(snapshot.relics.every((relic) => relic.name === 'Unknown relic' && relic.value === 0 && relic.roomId === '')).toBe(true);
        expect(JSON.stringify(snapshot)).not.toContain(state.relics[0].name);
        expect(snapshot.relics.every((relic) => relic.roomId !== state.relics[0].roomId)).toBe(true);
    });

    it('keeps hidden placeholder IDs collision-free and independent of source ordering', () => {
        const state = createRelicGame('room-1', 'room-1', 1);
        const firstFound = toPublicRelicSnapshot({
            ...state,
            relics: [
                { ...state.relics[0], id: 'hidden-relic-2', foundBy: 'alice' },
                state.relics[1],
            ],
        });
        const secondFound = toPublicRelicSnapshot({
            ...state,
            relics: [
                state.relics[0],
                { ...state.relics[1], foundBy: 'alice' },
            ],
        });

        expect(new Set(firstFound.relics.map((relic) => relic.id)).size).toBe(firstFound.relics.length);
        expect(hiddenPlaceholderIds(firstFound)).toEqual(hiddenPlaceholderIds(secondFound));
    });

    it('does not publish the deterministic expedition seed', () => {
        const blueprint = createProceduralRelicExpeditionBlueprint({
            seed: 'server-only-seed',
            theme: 'Hidden Keep',
        });
        const state = createRelicGameFromBlueprint(
            'room-1',
            'room-1',
            blueprint,
            1,
            {
                source: 'procedural',
                seed: blueprint.seed,
                theme: blueprint.theme,
                blueprintId: `procedural:${blueprint.seed}`,
            },
        );

        const snapshot = toPublicRelicSnapshot(state);
        const publishedSetup: Record<string, unknown> = { ...snapshot.setup };
        expect(publishedSetup.seed).toBeUndefined();
        expect(publishedSetup.blueprintId).toBeUndefined();
        expect(JSON.stringify(snapshot)).not.toContain(blueprint.seed);
    });

    it('rejects malformed required and nested snapshot fields', () => {
        const valid = toPublicRelicSnapshot(createRelicGame('room-1', 'room-1', 1));
        const malformed = [
            { ...valid, round: Number.NaN },
            { ...valid, roundTimeLimitMs: undefined },
            { ...valid, adminPlayerId: 1 },
            { ...valid, roundStartedAtEpochMs: 'soon' },
            { ...valid, map: [null] },
            { ...valid, relics: [null] },
            { ...valid, roomInvestigations: [null] },
            { ...valid, players: [null] },
            { ...valid, submittedPlayerIds: [null] },
            { ...valid, events: [null] },
            { ...valid, winnerIds: [null] },
            { ...valid, setup: { schemaVersion: 2, source: 'procedural' } },
            { ...valid, setup: { ...valid.setup, seed: 'leaked-seed' } },
            { ...valid, setup: { ...valid.setup, blueprintId: 'procedural:leaked-seed' } },
        ];

        expect(isRelicSnapshot(valid)).toBe(true);
        expect(malformed.every((candidate) => !isRelicSnapshot(candidate))).toBe(true);
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
            state = submitAndContinue(state, action, 4 + index);
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
            state = submitAndContinue(state, action, 4 + index);
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
        expect(toPublicRelicSnapshot(state).roomInvestigations).toContainEqual({
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

        state = submitAndContinue(state, { kind: 'search' }, 4);
        state = submitAndContinue(state, { kind: 'search' }, 5);

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
            state = submitAndContinue(state, action, 4 + index);
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

function hiddenPlaceholderIds(snapshot: RelicPublicSnapshot): readonly string[] {
    return snapshot.relics
        .filter((relic) => relic.name === 'Unknown relic')
        .map((relic) => relic.id);
}

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

function forceResolve(playerId: string, username: string): RelicCommand {
    void playerId;
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'force-resolve-round',
        gameId: 'room-1',
        username,
    };
}

function pickup(playerId: string, username: string, relicId: string): RelicCommand {
    void playerId;
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'pickup-relic',
        gameId: 'room-1',
        username,
        relicId,
    };
}

function continueReview(state: RelicGameState, now: number): RelicGameState {
    return applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'continue-review',
        gameId: 'room-1',
        username: 'Alice',
    }, {
        senderId: 'alice',
        now: () => now,
    }).state;
}

function submitAndContinue(
    state: RelicGameState,
    action: Extract<RelicCommand, { kind: 'submit-action' }>['action'],
    now: number,
): RelicGameState {
    const submitted = applyRelicCommand(
        state,
        submit('alice', 'Alice', action),
        {
            senderId: 'alice',
            now: () => now,
        },
    ).state;

    return submitted.phase === 'review'
        ? continueReview(submitted, now + 0.5)
        : submitted;
}
