import {
    applyRelicCommand,
    createProceduralRelicExpeditionBlueprint,
    createRelicGame,
    createRelicGameFromBlueprint,
    RELIC_PROTOCOL_VERSION
} from '@relic-hunters/mod.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

import { requireRelicCommandApplied } from './require-relic-command-applied.ts';

describe('Relic command evaluation', () => {
    it('returns a typed refusal without modifying state when a hunter acts before starting', () => {
        const state = createRelicGame('room-1', 'room-1', 10);
        const before = structuredClone(state);
        const result = applyRelicCommand(state, {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'submit-action',
            gameId: 'room-1',
            username: 'Alice',
            action: { kind: 'search' }
        }, { senderId: 'alice', now: 20 });

        expect(result.left).toEqual({ code: 'participant-required', message: 'Join the expedition before sending game commands.' });
        expect(result.right).toBeUndefined();
        expect(state).toEqual(before);
    });

    it('never creates a participant through a forged start command', () => {
        const result = applyRelicCommand(undefined, {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'start-expedition',
            gameId: 'room-1',
            username: 'Watcher'
        }, { senderId: 'watcher', now: 20 });
        expect(result.left?.code).toBe('participant-required');
        expect(result.right).toBeUndefined();
    });

    it('resolves and finishes a solo expedition without counting an unjoined watcher', () => {
        const command = { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: 'room-1', username: 'Alice' };
        let state = requireRelicCommandApplied(applyRelicCommand(undefined, { ...command, kind: 'join-expedition' }, { senderId: 'alice', now: 1 })).state;
        state = { ...state, maxRounds: 1 };
        expect(applyRelicCommand(state, { ...command, kind: 'start-expedition' }, { senderId: 'watcher', now: 2 }).left?.code).toBe('participant-required');
        state = requireRelicCommandApplied(applyRelicCommand(state, { ...command, kind: 'start-expedition' }, { senderId: 'alice', now: 3 })).state;
        state = requireRelicCommandApplied(
            applyRelicCommand(state, { ...command, kind: 'submit-action', action: { kind: 'search' } }, { senderId: 'alice', now: 4 })
        ).state;
        expect(state.phase).toBe('review');
        expect(state.players.map((player) => player.playerId)).toEqual(['alice']);
        state = requireRelicCommandApplied(applyRelicCommand(state, { ...command, kind: 'continue-review' }, { senderId: 'alice', now: 5 })).state;
        expect(state.phase).toBe('finished');
    });

    it('returns invalid expedition geometry as a typed construction refusal', () => {
        const blueprint = { ...createProceduralRelicExpeditionBlueprint({ seed: 'broken-map' }), rooms: [] };
        const result = createRelicGameFromBlueprint({ gameId: 'room-1', roomId: 'room-1', blueprint, now: 55 });

        expect(result.left).toMatchObject({ code: 'invalid-expedition-blueprint' });
        expect(result.left?.message).toContain('blueprint');
        expect(result.right).toBeUndefined();
    });

    it('refuses administrator commands when an existing roster has no assigned administrator', () => {
        const joined = requireRelicCommandApplied(applyRelicCommand(undefined, {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'join-expedition',
            gameId: 'room-1',
            username: 'Alice'
        }, { senderId: 'alice', now: 1 })).state;
        const unassigned = { ...joined, adminPlayerId: undefined };
        const commands = [
            { kind: 'start-expedition' },
            { kind: 'set-round-limit', timeLimitMs: 180000 },
            { kind: 'continue-review' }
        ] as const;
        for (const command of commands) {
            const result = applyRelicCommand({
                ...unassigned,
                phase: command.kind === 'continue-review' ? 'review' : 'lobby'
            }, {
                protocolVersion: RELIC_PROTOCOL_VERSION,
                gameId: 'room-1',
                username: 'Alice',
                ...command
            }, { senderId: 'alice', now: 2 });
            expect(result.left).toMatchObject({ code: 'administrator-required' });
            expect(result.right).toBeUndefined();
        }
    });

    it('refuses a newcomer starting an existing expedition with no assigned administrator', () => {
        const joined = requireRelicCommandApplied(applyRelicCommand(undefined, {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'join-expedition',
            gameId: 'room-1',
            username: 'Alice'
        }, { senderId: 'alice', now: 1 })).state;
        const unassigned = { ...joined, adminPlayerId: undefined };
        const before = structuredClone(unassigned);
        const result = applyRelicCommand(unassigned, {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'start-expedition',
            gameId: 'room-1',
            username: 'Bob'
        }, { senderId: 'bob', now: 2 });

        expect(result.left).toMatchObject({ code: 'participant-required' });
        expect(result.right).toBeUndefined();
        expect(unassigned).toEqual(before);
    });

    it('appoints the first entrant only when the roster is empty', () => {
        const joined = requireRelicCommandApplied(applyRelicCommand(undefined, {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'join-expedition',
            gameId: 'room-1',
            username: 'Alice'
        }, { senderId: 'alice', now: 1 })).state;
        expect(joined.adminPlayerId).toBe('alice');

        const unassigned = { ...joined, adminPlayerId: undefined };
        const before = structuredClone(unassigned);
        const next = requireRelicCommandApplied(applyRelicCommand(unassigned, {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'join-expedition',
            gameId: 'room-1',
            username: 'Bob'
        }, { senderId: 'bob', now: 2 })).state;

        expect(next.players.map((player) => player.playerId)).toEqual(['alice', 'bob']);
        expect(next.adminPlayerId).toBeUndefined();
        expect(unassigned).toEqual(before);
    });

    it('uses the captured epoch for initialization, admission and events', () => {
        const command = {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'join-expedition',
            gameId: 'room-1',
            username: 'Alice'
        } as const;
        const result = applyRelicCommand(undefined, command, { senderId: 'alice', now: 1234 });
        const repeated = applyRelicCommand(undefined, command, { senderId: 'alice', now: 1234 });

        expect(result.left).toBeUndefined();
        expect(result.right?.state).toMatchObject({ createdAtEpochMs: 1234, updatedAtEpochMs: 1234 });
        expect(result.right?.state.events.map((event) => event.createdAtEpochMs)).toEqual([1234, 1234]);
        expect(repeated).toEqual(result);
    });
});
