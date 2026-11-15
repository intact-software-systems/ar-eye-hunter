import {
    applyRelicCommand,
    createProceduralRelicExpeditionBlueprint,
    createRelicGame,
    createRelicGameFromBlueprint,
    decodeRelicSnapshotPayload,
    isRelicCommand,
    isRelicHunterEvent,
    isRelicRoundTransitionEvent,
    isRelicSnapshot,
    RELIC_PROTOCOL_VERSION,
    toPublicRelicSnapshot,
    type RelicCommand,
    type RelicGameState,
    type RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

import { requireRelicCommandApplied } from './require-relic-command-applied.ts';

describe('Relic Hunters game rules', () => {
    it('keeps submitted actions hidden until all active hunters have acted', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Bob'), { presentPlayerIds: ['bob'], senderId: 'bob', now: 3 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 4 })).state;

        const afterAlice = requireRelicCommandApplied(applyRelicCommand(
            state,
            submit('Alice', { kind: 'search' }),
            { presentPlayerIds: ['alice'], senderId: 'alice', now: 5 }
        ));
        const snapshot = toPublicRelicSnapshot(afterAlice.state);

        expect(afterAlice.resolvedRound).toBe(false);
        expect(snapshot.submittedPlayerIds).toEqual(['alice']);
        expect(JSON.stringify(snapshot)).not.toContain('search');
    });

    it('resolves a round after every active hunter submits', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Bob'), { presentPlayerIds: ['bob'], senderId: 'bob', now: 3 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 4 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(
            state,
            submit('Alice', { kind: 'search' }),
            { presentPlayerIds: ['alice'], senderId: 'alice', now: 5 }
        )).state;
        const result = requireRelicCommandApplied(applyRelicCommand(
            state,
            submit('Bob', { kind: 'move', targetRoomId: 'hallway' }),
            { presentPlayerIds: ['bob'], senderId: 'bob', now: 6 }
        ));

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
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Bob'), { presentPlayerIds: ['bob'], senderId: 'bob', now: 3 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 4 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(
            state,
            submit('Alice', { kind: 'move', targetRoomId: 'hallway' }),
            { presentPlayerIds: ['alice'], senderId: 'alice', now: 5 }
        )).state;

        const result = requireRelicCommandApplied(
            applyRelicCommand(state, forceResolve('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 65_000 })
        );

        expect(result.resolvedRound).toBe(true);
        expect(result.state.round).toBe(1);
        expect(result.state.phase).toBe('review');
        expect(result.state.pendingActions).toEqual([]);
        expect(result.state.players.find((player) => player.playerId === 'alice')?.roomId)
            .toBe('hallway');
        expect(result.state.players.find((player) => player.playerId === 'bob')?.roomId)
            .toBe('entrance');
        expect(result.state.events.some((event) => event.message.includes('Missing plans skipped: Bob'))).toBe(true);

        const continued = continueReview(result.state, 65_500);
        expect(continued.round).toBe(2);
        expect(continued.phase).toBe('planning');
    });

    it('rejects force-resolve before the round timer expires', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Bob'), { presentPlayerIds: ['bob'], senderId: 'bob', now: 3 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 4 })).state;

        expect(
            applyRelicCommand(state, forceResolve('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 10 }).left?.message
        ).toBe('Round timer has not expired.');
        expect(state.round).toBe(1);
    });

    it('maps resolved turn events to scene animation cues', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = {
            ...state,
            relics: state.relics.filter((relic) => relic.roomId !== 'entrance')
        };
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Bob'), { presentPlayerIds: ['bob'], senderId: 'bob', now: 3 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 4 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(
            state,
            submit('Alice', { kind: 'search' }),
            { presentPlayerIds: ['alice'], senderId: 'alice', now: 5 }
        )).state;

        const result = requireRelicCommandApplied(applyRelicCommand(
            state,
            submit('Bob', { kind: 'move', targetRoomId: 'hallway' }),
            { presentPlayerIds: ['bob'], senderId: 'bob', now: 6 }
        ));
        const cueByEventType = new Map(
            result.state.events.map((event) => [event.type, event.animationCue?.type])
        );

        expect(cueByEventType.get('action_revealed')).toBe('noise_pulse');
        expect(cueByEventType.get('player_searched')).toBe('search_altar');
        expect(cueByEventType.get('player_moved')).toBe('camera_move');
        expect(cueByEventType.get('noise_pulse')).toBe('noise_pulse');
        expect(result.state.events.find((event) => event.type === 'player_moved')?.animationCue)
            .toMatchObject({
                fromRoomId: 'entrance',
                roomId: 'hallway'
            });
    });

    it('rejects self-stealing without duplicating a carried relic or increasing its score', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 3 })).state;
        state =
            requireRelicCommandApplied(applyRelicCommand(state, pickup('Alice', 'visitor-badge'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 4 }))
                .state;
        const before = structuredClone(state);
        const attempted = applyRelicCommand(state, submit('Alice', { kind: 'steal', targetPlayerId: 'alice' }), {
            presentPlayerIds: ['alice'],
            senderId: 'alice',
            now: 5
        });
        expect(attempted.left?.code).toBe('steal-self-forbidden');
        expect(attempted.right).toBeUndefined();
        expect(state).toEqual(before);
        expect(state.players[0].relicIds).toEqual(['visitor-badge']);
        expect(state.players[0].score).toBe(1);
    });

    it('lets an active hunter instantly pick up a visible same-room relic', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 3 })).state;

        const result = requireRelicCommandApplied(
            applyRelicCommand(state, pickup('Alice', 'visitor-badge'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 4 })
        );
        const alice = result.state.players.find((player) => player.playerId === 'alice');

        expect(result.resolvedRound).toBe(false);
        expect(result.state.phase).toBe('planning');
        expect(alice?.relicIds).toContain('visitor-badge');
        expect(alice?.score).toBeGreaterThan(0);
        expect(result.state.relics.find((relic) => relic.id === 'visitor-badge')).toMatchObject({
            foundBy: 'alice',
            carriedBy: 'alice'
        });
        expect(result.state.events.at(-1)).toMatchObject({
            type: 'relic_picked_up',
            animationCue: {
                type: 'relic_pickup',
                playerId: 'alice',
                roomId: 'entrance',
                relicId: 'visitor-badge'
            }
        });
    });

    it('rejects instant pickup when the relic is unavailable or in another room', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 3 })).state;

        expect(
            applyRelicCommand(state, pickup('Alice', 'sun-disk'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 4 }).left?.message
        ).toBe('Relic is not in this hunter\'s room.');

        state =
            requireRelicCommandApplied(applyRelicCommand(state, pickup('Alice', 'visitor-badge'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 5 }))
                .state;

        expect(
            applyRelicCommand(state, pickup('Alice', 'visitor-badge'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 6 }).left?.message
        ).toBe('Relic has already been claimed.');
    });

    it('rejects instant pickup during review', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 3 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(
            state,
            submit('Alice', { kind: 'move', targetRoomId: 'hallway' }),
            { presentPlayerIds: ['alice'], senderId: 'alice', now: 4 }
        )).state;

        expect(state.phase).toBe('review');
        expect(
            applyRelicCommand(state, pickup('Alice', 'copper-coin'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 5 }).left?.message
        ).toBe('Review the revealed actions before planning the next turn.');
    });

    it('allows only the expedition administrator to continue review', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Bob'), { presentPlayerIds: ['bob'], senderId: 'bob', now: 3 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 4 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(
            state,
            submit('Alice', { kind: 'search' }),
            { presentPlayerIds: ['alice'], senderId: 'alice', now: 5 }
        )).state;
        state = requireRelicCommandApplied(applyRelicCommand(
            state,
            submit('Bob', { kind: 'move', targetRoomId: 'hallway' }),
            { presentPlayerIds: ['bob'], senderId: 'bob', now: 6 }
        )).state;

        expect(
            applyRelicCommand(state, {
                protocolVersion: RELIC_PROTOCOL_VERSION,
                kind: 'continue-review',
                gameId: 'room-1',
                username: 'Bob'
            }, { presentPlayerIds: ['bob'], senderId: 'bob', now: 7 }).left?.message
        ).toBe('Only the administrator can continue the review.');
        expect(continueReview(state, 8).phase).toBe('planning');
    });

    it('lets a hunter update their locked plan before the round resolves', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Bob'), { presentPlayerIds: ['bob'], senderId: 'bob', now: 3 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 4 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(
            state,
            submit('Alice', { kind: 'move', targetRoomId: 'storage' }),
            { presentPlayerIds: ['alice'], senderId: 'alice', now: 5 }
        )).state;
        state = requireRelicCommandApplied(applyRelicCommand(
            state,
            submit('Alice', { kind: 'move', targetRoomId: 'hallway' }),
            { presentPlayerIds: ['alice'], senderId: 'alice', now: 6 }
        )).state;

        const result = requireRelicCommandApplied(applyRelicCommand(
            state,
            submit('Bob', { kind: 'search' }),
            { presentPlayerIds: ['bob'], senderId: 'bob', now: 7 }
        ));

        expect(result.resolvedRound).toBe(true);
        expect(result.state.pendingActions).toEqual([]);
        expect(result.state.players.find((player) => player.playerId === 'alice')?.roomId)
            .toBe('hallway');
    });

    it('rejects late joins after the expedition has started', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 3 })).state;

        expect(
            applyRelicCommand(state, join('Bob'), { presentPlayerIds: ['bob'], senderId: 'bob', now: 4 }).left?.message
        ).toBe('Cannot join an expedition after it has started.');
    });

    it('rejects non-admin expedition starts', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Bob'), { presentPlayerIds: ['bob'], senderId: 'bob', now: 3 })).state;

        expect(
            applyRelicCommand(state, start('Bob'), { presentPlayerIds: ['bob'], senderId: 'bob', now: 4 }).left?.message
        ).toBe('Only the administrator can start the expedition.');
        expect(state.phase).toBe('lobby');
    });

    it('rejects non-adjacent move submissions before they enter the pending plan', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 3 })).state;

        expect(
            applyRelicCommand(
                state,
                submit('Alice', { kind: 'move', targetRoomId: 'exit' }),
                { presentPlayerIds: ['alice'], senderId: 'alice', now: 4 }
            ).left?.message
        ).toBe('Move target is not adjacent.');
        expect(state.pendingActions).toEqual([]);
    });

    it('marks empty room searches as durable room investigations', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = {
            ...state,
            relics: state.relics.filter((relic) => relic.roomId !== 'entrance')
        };
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 3 })).state;

        state = requireRelicCommandApplied(applyRelicCommand(
            state,
            submit('Alice', { kind: 'search' }),
            { presentPlayerIds: ['alice'], senderId: 'alice', now: 4 }
        )).state;

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
            revealedRoomId: 'storage'
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
                state.relics[1]
            ]
        });
        const secondFound = toPublicRelicSnapshot({
            ...state,
            relics: [
                state.relics[0],
                { ...state.relics[1], foundBy: 'alice' }
            ]
        });

        expect(new Set(firstFound.relics.map((relic) => relic.id)).size).toBe(firstFound.relics.length);
        expect(hiddenPlaceholderIds(firstFound)).toEqual(hiddenPlaceholderIds(secondFound));
    });

    it('does not publish the deterministic expedition seed', () => {
        const blueprint = createProceduralRelicExpeditionBlueprint({
            seed: 'server-only-seed',
            theme: 'Hidden Keep'
        });
        const state = createRelicGameFromBlueprint(
            {
                gameId: 'room-1',
                roomId: 'room-1',
                blueprint,
                now: 1,
                setup: {
                    source: 'procedural',
                    seed: blueprint.seed,
                    theme: blueprint.theme,
                    blueprintId: `procedural:${blueprint.seed}`
                }
            }
        ).fold(
            (refusal) => {
                throw new Error(`Expected a valid fixture blueprint: ${refusal.message}`);
            },
            (state) => state
        );

        const snapshot = toPublicRelicSnapshot(state);

        expect(snapshot.setup).not.toHaveProperty('seed');
        expect(snapshot.setup).not.toHaveProperty('blueprintId');
        expect(JSON.stringify(snapshot)).not.toContain(blueprint.seed);
    });

    it('accepts a public snapshot', () => {
        expect(isRelicSnapshot(toPublicRelicSnapshot(createRelicGame('room-1', 'room-1', 1)))).toBe(true);
    });

    it.each([
        { label: 'a NaN round', override: { round: Number.NaN } },
        { label: 'no roundTimeLimitMs', override: { roundTimeLimitMs: undefined } },
        { label: 'a numeric adminPlayerId', override: { adminPlayerId: 1 } },
        { label: 'a text roundStartedAtEpochMs', override: { roundStartedAtEpochMs: 'soon' } },
        { label: 'a null map entry', override: { map: [null] } },
        { label: 'a null relic', override: { relics: [null] } },
        { label: 'a null room investigation', override: { roomInvestigations: [null] } },
        { label: 'a null player', override: { players: [null] } },
        { label: 'a null submitted player id', override: { submittedPlayerIds: [null] } },
        { label: 'a null event', override: { events: [null] } },
        { label: 'a null winner id', override: { winnerIds: [null] } },
        { label: 'a setup of another schema version', override: { setup: { schemaVersion: 2, source: 'procedural' } } }
    ])('refuses a snapshot with $label', ({ override }) => {
        const valid = toPublicRelicSnapshot(createRelicGame('room-1', 'room-1', 1));

        expect(isRelicSnapshot({ ...valid, ...override })).toBe(false);
    });

    it.each([
        { label: 'a leaked seed', leak: { seed: 'leaked-seed' } },
        { label: 'a leaked blueprintId', leak: { blueprintId: 'procedural:leaked-seed' } }
    ])('refuses a snapshot whose setup carries $label', ({ leak }) => {
        const valid = toPublicRelicSnapshot(createRelicGame('room-1', 'room-1', 1));

        expect(isRelicSnapshot({ ...valid, setup: { ...valid.setup, ...leak } })).toBe(false);
    });

    it('accepts a command', () => {
        expect(isRelicCommand(submit('Alice', { kind: 'search' }))).toBe(true);
    });

    it.each([
        { label: 'null', candidate: () => null },
        { label: 'a string', candidate: () => 'submit-action' },
        { label: 'a number', candidate: () => 42 },
        { label: 'an empty array', candidate: () => [] },
        { label: 'an array holding a valid command', candidate: () => [submit('Alice', { kind: 'search' })] },
        { label: 'another protocol version', candidate: () => ({ ...submit('Alice', { kind: 'search' }), protocolVersion: RELIC_PROTOCOL_VERSION + 1 }) },
        { label: 'no gameId', candidate: () => withoutField(submit('Alice', { kind: 'search' }), 'gameId') },
        { label: 'no username', candidate: () => withoutField(submit('Alice', { kind: 'search' }), 'username') },
        { label: 'an unknown command kind', candidate: () => ({ ...submit('Alice', { kind: 'search' }), kind: 'teleport' }) },
        { label: 'a null action', candidate: () => ({ ...submit('Alice', { kind: 'search' }), action: null }) },
        { label: 'an array as the action', candidate: () => ({ ...submit('Alice', { kind: 'search' }), action: [] }) },
        { label: 'a string as the action', candidate: () => ({ ...submit('Alice', { kind: 'search' }), action: 'search' }) },
        { label: 'an unknown action kind', candidate: () => ({ ...submit('Alice', { kind: 'search' }), action: { kind: 'teleport' } }) }
    ])('refuses a command that is $label', ({ candidate }) => {
        expect(isRelicCommand(candidate())).toBe(false);
    });

    it('decodes a snapshot bare or inside its publication envelope', () => {
        const valid = toPublicRelicSnapshot(createRelicGame('room-1', 'room-1', 1));

        expect(decodeRelicSnapshotPayload(valid).right).toBe(valid);
        expect(decodeRelicSnapshotPayload({ snapshot: valid }).right).toBe(valid);
    });

    it.each([
        { label: 'null', payload: () => null },
        { label: 'a string', payload: () => 'snapshot' },
        { label: 'an empty array', payload: () => [] },
        { label: 'an array holding a snapshot', payload: () => [toPublicRelicSnapshot(createRelicGame('room-1', 'room-1', 1))] },
        { label: 'an envelope holding null', payload: () => ({ snapshot: null }) },
        { label: 'an envelope holding an array of a snapshot', payload: () => ({ snapshot: [toPublicRelicSnapshot(createRelicGame('room-1', 'room-1', 1))] }) }
    ])('refuses a snapshot payload that is $label', ({ payload }) => {
        expect(decodeRelicSnapshotPayload(payload()).left).toEqual(new TypeError('not a Relic snapshot'));
    });

    it('accepts a round transition', () => {
        expect(isRelicRoundTransitionEvent(roundTransition())).toBe(true);
    });

    it.each([
        { label: 'null', candidate: () => null },
        { label: 'an empty array', candidate: () => [] },
        { label: 'an array holding a valid transition', candidate: () => [roundTransition()] },
        { label: 'another protocol version', candidate: () => ({ ...roundTransition(), protocolVersion: RELIC_PROTOCOL_VERSION + 1 }) },
        { label: 'an unknown transition', candidate: () => ({ ...roundTransition(), transition: 'paused' }) },
        { label: 'no text', candidate: () => withoutField(roundTransition(), 'text') }
    ])('refuses a round transition that is $label', ({ candidate }) => {
        expect(isRelicRoundTransitionEvent(candidate())).toBe(false);
    });

    it('accepts an action-recorded and a command-refused hunter event', () => {
        expect(isRelicHunterEvent(recordedHunterEvent())).toBe(true);
        expect(isRelicHunterEvent(refusedHunterEvent())).toBe(true);
    });

    it.each([
        { label: 'null', candidate: () => null },
        { label: 'an empty array', candidate: () => [] },
        { label: 'an array holding a valid event', candidate: () => [recordedHunterEvent()] },
        { label: 'another protocol version', candidate: () => ({ ...recordedHunterEvent(), protocolVersion: RELIC_PROTOCOL_VERSION + 1 }) },
        { label: 'an unknown kind', candidate: () => ({ ...recordedHunterEvent(), kind: 'action-revealed' }) },
        { label: 'a null action', candidate: () => ({ ...recordedHunterEvent(), action: null }) },
        { label: 'an array as the action', candidate: () => ({ ...recordedHunterEvent(), action: [] }) },
        { label: 'a refusal of an unknown command', candidate: () => ({ ...refusedHunterEvent(), command: 'teleport' }) },
        { label: 'a refusal with no principalId', candidate: () => withoutField(refusedHunterEvent(), 'principalId') }
    ])('refuses a hunter event that is $label', ({ candidate }) => {
        expect(isRelicHunterEvent(candidate())).toBe(false);
    });

    it('adds room-specific notes to empty investigations', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = {
            ...state,
            relics: state.relics.filter((relic) => relic.roomId !== 'storage')
        };
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 3 })).state;

        for (
            const [index, action] of ([
                { kind: 'move', targetRoomId: 'storage' },
                { kind: 'search' }
            ] as const).entries()
        ) {
            state = submitAndContinue(state, action, 4 + index);
        }

        expect(state.roomInvestigations).toContainEqual(expect.objectContaining({
            roomId: 'storage',
            result: 'empty',
            summary: 'The crates held a torn supply map, but no relic.',
            hint: 'The supply marks point back toward the Entrance and onward through the Trap Room.',
            effect: 'map-fragment',
            revealedRoomId: 'trap'
        }));
    });

    it('marks relic discoveries as durable room investigations', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 3 })).state;

        for (
            const [index, action] of ([
                { kind: 'move', targetRoomId: 'storage' },
                { kind: 'search' }
            ] as const).entries()
        ) {
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
            relicId: 'sun-disk'
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
            relicId: 'sun-disk'
        });
    });

    it('softens repeated searches in already investigated rooms', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 3 })).state;

        state = submitAndContinue(state, { kind: 'search' }, 4);
        state = submitAndContinue(state, { kind: 'search' }, 5);

        expect(state.roomInvestigations).toHaveLength(1);
        expect(state.events.at(-3)?.message).toContain('useful clues were already marked');
    });

    it('scores found relics and escape bonus when a hunter exits safely', () => {
        let state = createRelicGame('room-1', 'room-1', 1);
        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 3 })).state;

        for (
            const [index, action] of ([
                { kind: 'move', targetRoomId: 'storage' },
                { kind: 'search' },
                { kind: 'move', targetRoomId: 'entrance' },
                { kind: 'move', targetRoomId: 'hallway' },
                { kind: 'move', targetRoomId: 'trap' },
                { kind: 'move', targetRoomId: 'monster' },
                { kind: 'move', targetRoomId: 'exit' },
                { kind: 'escape' }
            ] as const).entries()
        ) {
            state = submitAndContinue(state, action, 4 + index);
        }

        const alice = state.players.find((player) => player.playerId === 'alice');
        expect(state.phase).toBe('finished');
        expect(alice).toMatchObject({
            escaped: true,
            score: 11,
            relicIds: []
        });
        expect(state.relics.find((relic) => relic.id === 'sun-disk')).toMatchObject({
            foundBy: 'alice',
            escapedBy: 'alice'
        });
        expect(state.winnerIds).toEqual(['alice']);
    });
});

function hiddenPlaceholderIds(snapshot: RelicPublicSnapshot): readonly string[] {
    return snapshot.relics
        .filter((relic) => relic.name === 'Unknown relic')
        .map((relic) => relic.id);
}

function join(username: string): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username
    };
}

function start(username: string): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'start-expedition',
        gameId: 'room-1',
        username
    };
}

function submit(
    username: string,
    action: Extract<RelicCommand, { kind: 'submit-action'; }>['action']
): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'submit-action',
        gameId: 'room-1',
        username,
        action
    };
}

function forceResolve(username: string): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'force-resolve-round',
        gameId: 'room-1',
        username
    };
}

function pickup(username: string, relicId: string): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'pickup-relic',
        gameId: 'room-1',
        username,
        relicId
    };
}

function continueReview(state: RelicGameState, now: number): RelicGameState {
    return requireRelicCommandApplied(applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'continue-review',
        gameId: 'room-1',
        username: 'Alice'
    }, { presentPlayerIds: ['alice'], senderId: 'alice', now: now })).state;
}

function submitAndContinue(
    state: RelicGameState,
    action: Extract<RelicCommand, { kind: 'submit-action'; }>['action'],
    now: number
): RelicGameState {
    const submitted = requireRelicCommandApplied(applyRelicCommand(
        state,
        submit('Alice', action),
        { presentPlayerIds: ['alice'], senderId: 'alice', now: now }
    )).state;

    return submitted.phase === 'review'
        ? continueReview(submitted, now + 0.5)
        : submitted;
}

function withoutField(value: object, field: string): object {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

function roundTransition(): object {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        gameId: 'room-1',
        createdAtEpochMs: 1,
        round: 1,
        phase: 'planning',
        transition: 'round-started',
        text: 'Round 1 begins.'
    };
}

function recordedHunterEvent(): object {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        gameId: 'room-1',
        principalId: 'alice',
        playerId: 'alice-session',
        kind: 'action-recorded',
        round: 1,
        action: { kind: 'search' }
    };
}

function refusedHunterEvent(): object {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        gameId: 'room-1',
        principalId: 'alice',
        playerId: 'alice-session',
        kind: 'command-refused',
        command: 'submit-action',
        text: 'Not your turn.',
        completedGameId: null
    };
}
