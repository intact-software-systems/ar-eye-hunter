import type {
    RelicCharacterId,
    RelicGameState,
    RelicPublicSnapshot
} from '@ar-eye-hunter/relic-hunters/mod.ts';
import {
    applyRelicCommand,
    createRelicGame,
    RELIC_PROTOCOL_VERSION,
    toPublicRelicSnapshot
} from '@ar-eye-hunter/relic-hunters/mod.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

import { requireRelicCommandApplied } from '../../../packages/tests/relic-hunters/require-relic-command-applied.ts';
import { computeRelicGameViewModel } from '../src/game/game-view-model.ts';

interface RelicTestPlayerAdmission {
    readonly state: RelicGameState;
    readonly senderId: string;
    readonly username: string;
    readonly characterId: RelicCharacterId;
    readonly now: number;
}

const NOW = 1_700_000_000_000;

describe('computeRelicGameViewModel', () => {
    it('derives planning targets, action legality, and objective from a shared rules snapshot', () => {
        const snapshot = planningSnapshot();
        const viewModel = computeRelicGameViewModel({
            revealedEvents: [],
            snapshot,
            localPlayerId: 'alice-session',
            draft: { kind: 'move', targetRoomId: 'hallway' },
            lang: 'en'
        });

        expect(viewModel.currentPlayer?.username).toBe('Alice');
        expect(viewModel.currentRoom?.id).toBe('entrance');
        expect(viewModel.moveTargets).toEqual(['hallway', 'storage']);
        expect(viewModel.stealTargets.map((player) => player.username)).toEqual(['Bob']);
        expect(viewModel.actionOptions.move).toMatchObject({
            legal: true,
            consequence: { text: '2 paths open', status: 'ok' }
        });
        expect(viewModel.actionOptions.steal).toMatchObject({
            legal: true,
            consequence: { text: '1 hunter here', status: 'ok' }
        });
        expect(viewModel.actionOptions.escape).toMatchObject({
            legal: false,
            consequence: { text: 'not at exit room', status: 'block' }
        });
        expect(viewModel.turnStatus).toMatchObject({
            phase: 'planning',
            activePlayerCount: 2,
            submittedPlayerCount: 0,
            waitingPlayerCount: 2,
            canSubmit: true,
            isLocked: false
        });
        expect(viewModel.objective).toContain('Find relics, then escape within 10 rounds.');
    });

    it('marks a submitted local player as locked and waiting for the remaining party', () => {
        let state = planningState();
        state = requireRelicCommandApplied(applyRelicCommand(
            state,
            {
                protocolVersion: RELIC_PROTOCOL_VERSION,
                kind: 'submit-action',
                gameId: 'game-1',
                username: 'Alice',
                action: { kind: 'move', targetRoomId: 'hallway' }
            },
            { senderId: 'alice-session', now: NOW + 4 }
        )).state;

        const viewModel = computeRelicGameViewModel({
            revealedEvents: [],
            snapshot: toPublicRelicSnapshot(state),
            localPlayerId: 'alice-session',
            draft: { kind: 'search' },
            lang: 'en'
        });

        expect(viewModel.turnStatus).toMatchObject({
            submittedPlayerCount: 1,
            waitingPlayerCount: 1,
            canSubmit: false,
            isLocked: true
        });
        expect(viewModel.objective).toBe('Plan locked. Waiting for 1 hunter.');
    });

    it('does not infer administrator authority from roster order when none is assigned', () => {
        const unassignedSnapshot = { ...planningSnapshot(), adminPlayerId: undefined };
        const viewModel = computeRelicGameViewModel({
            revealedEvents: [],
            snapshot: unassignedSnapshot,
            localPlayerId: 'alice-session',
            draft: { kind: 'search' },
            lang: 'en'
        });

        expect(viewModel.isAdmin).toBe(false);
    });

    it('does not grant administrator controls before a hunter joins', () => {
        const viewModel = computeRelicGameViewModel({
            revealedEvents: [],
            snapshot: toPublicRelicSnapshot(createRelicGame('game-1', 'room-1', NOW)),
            localPlayerId: 'alice-session',
            draft: { kind: 'search' },
            lang: 'en'
        });
        expect(viewModel.isAdmin).toBe(false);
    });

    it('surfaces searched-room danger and final-round warnings', () => {
        const base = planningSnapshot();
        const snapshot: RelicPublicSnapshot = {
            ...base,
            round: base.maxRounds,
            roomInvestigations: [
                ...base.roomInvestigations,
                {
                    roomId: 'entrance',
                    searchedByPlayerId: 'alice-session',
                    searchedByUsername: 'Alice',
                    searchedAtRound: 1,
                    searchedAtEpochMs: NOW + 5,
                    result: 'empty',
                    summary: 'The entry stones are cracked.',
                    hint: 'The ceiling is unstable.',
                    effect: 'ordinary-search',
                    danger: 'Ceiling cracks widen overhead.'
                }
            ]
        };

        const viewModel = computeRelicGameViewModel({ revealedEvents: [], snapshot, localPlayerId: 'alice-session', draft: { kind: 'search' }, lang: 'en' });

        expect(viewModel.actionBriefDanger).toBe('Ceiling cracks widen overhead.');
        expect(viewModel.roundLimitWarning).toMatchObject({
            kind: 'round-limit',
            severity: 'danger',
            message: 'Final round - escape or be lost to the ruin.'
        });
    });

    it('allows escape only from the exit room', () => {
        const base = planningSnapshot();
        const snapshot: RelicPublicSnapshot = {
            ...base,
            players: base.players.map((player) => player.playerId === 'alice-session' ? { ...player, roomId: 'exit' } : player)
        };

        const viewModel = computeRelicGameViewModel({ revealedEvents: [], snapshot, localPlayerId: 'alice-session', draft: { kind: 'escape' }, lang: 'en' });

        expect(viewModel.currentRoom?.kind).toBe('exit');
        expect(viewModel.actionOptions.escape).toMatchObject({
            legal: true,
            consequence: { text: 'exit door in reach', status: 'ok' }
        });
        expect(viewModel.submitBlocker).toBeUndefined();
        expect(viewModel.turnStatus.canSubmit).toBe(true);
    });

    it('blocks defeated hunters from submitting and removes them from the active count', () => {
        const base = planningSnapshot();
        const snapshot: RelicPublicSnapshot = {
            ...base,
            players: base.players.map((player) =>
                player.playerId === 'alice-session'
                    ? { ...player, health: 0, defeated: true }
                    : player
            )
        };

        const viewModel = computeRelicGameViewModel({ revealedEvents: [], snapshot, localPlayerId: 'alice-session', draft: { kind: 'search' }, lang: 'en' });

        expect(viewModel.submitBlocker).toBe('You are down and cannot act this expedition.');
        expect(viewModel.turnStatus).toMatchObject({
            activePlayerCount: 1,
            waitingPlayerCount: 1,
            canSubmit: false
        });
        expect(viewModel.objective).toBe('You are down. The ruin keeps your relics.');
    });

    it('switches the objective to watching during round review', () => {
        const viewModel = computeRelicGameViewModel({
            revealedEvents: [],
            snapshot: { ...planningSnapshot(), phase: 'review', submittedPlayerIds: [] },
            localPlayerId: 'alice-session',
            draft: { kind: 'search' },
            lang: 'en'
        });

        expect(viewModel.turnStatus.phase).toBe('review');
        expect(viewModel.turnStatus.canSubmit).toBe(false);
        expect(viewModel.objective).toBe('Watch the revealed plans before the next turn.');
    });
});

function planningSnapshot(): RelicPublicSnapshot {
    return toPublicRelicSnapshot(planningState());
}

function planningState(): RelicGameState {
    let state = createRelicGame('game-1', 'room-1', NOW);
    state = join({ state: state, senderId: 'alice-session', username: 'Alice', characterId: 'kael-ironstride', now: NOW + 1 });
    state = join({ state: state, senderId: 'bob-session', username: 'Bob', characterId: 'nyra-vale', now: NOW + 2 });
    state = requireRelicCommandApplied(applyRelicCommand(
        state,
        {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'start-expedition',
            gameId: 'game-1',
            username: 'Alice'
        },
        { senderId: 'alice-session', now: NOW + 3 }
    )).state;
    return state;
}

function join(
    { state, senderId, username, characterId, now }: RelicTestPlayerAdmission
): RelicGameState {
    return requireRelicCommandApplied(applyRelicCommand(
        state,
        {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'join-expedition',
            gameId: 'game-1',
            username,
            characterId
        },
        { senderId, now: now }
    )).state;
}
