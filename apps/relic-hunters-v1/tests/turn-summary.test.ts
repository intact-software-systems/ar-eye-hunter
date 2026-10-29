import type {
    RelicCharacterId,
    RelicEvent,
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
import {
    deriveCurrentTurnSummaryModel,
    isPersonalEvent,
    turnTimelineCategory
} from '../src/game/turn-summary.ts';

interface RelicTestPlayerAdmission {
    readonly state: RelicGameState;
    readonly senderId: string;
    readonly username: string;
    readonly characterId: RelicCharacterId;
    readonly now: number;
}

interface RelicTestEventInput {
    readonly id: string;
    readonly type: RelicEvent['type'];
    readonly message: string;
    readonly overrides: Partial<RelicEvent>;
}

const NOW = 1_700_000_000_000;

describe('turn summary and timeline derivation', () => {
    it('summarizes an unlocked planning turn', () => {
        const snapshot = planningSnapshot();

        const summary = deriveCurrentTurnSummaryModel({
            snapshot,
            localPlayerId: 'alice-session',
            events: [],
            lang: 'en'
        });

        expect(summary.copy).toMatchObject({
            kind: 'planning',
            eyebrow: 'Round 1',
            title: 'Choose one plan'
        });
        expect(summary.stats).toEqual(['0/2 locked', '2 waiting']);
    });

    it('summarizes a locked local plan while another hunter is still choosing', () => {
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
            { presentPlayerIds: ['alice-session'], senderId: 'alice-session', now: NOW + 4 }
        )).state;

        const summary = deriveCurrentTurnSummaryModel({
            snapshot: toPublicRelicSnapshot(state),
            localPlayerId: 'alice-session',
            events: [],
            lang: 'en'
        });

        expect(summary.copy).toMatchObject({
            kind: 'locked',
            eyebrow: 'Plan Locked',
            title: 'Your plan is locked',
            detail: 'Waiting for 1 hunter to lock a plan.'
        });
        expect(summary.stats).toEqual(['1/2 locked', '1 waiting']);
    });

    it('counts recent personal and castle events in the current turn stats', () => {
        const events: readonly RelicEvent[] = [
            event({ id: 'reveal', type: 'action_revealed', message: 'Round 1 actions are revealed.', overrides: {} }),
            event({
                id: 'search',
                type: 'player_searched',
                message: 'Alice searched the Entrance.',
                overrides: {
                    animationCue: { type: 'search_altar', playerId: 'alice-session', roomId: 'entrance' }
                }
            }),
            event({ id: 'noise', type: 'noise_pulse', message: 'The ruin hears 2 noise.', overrides: {} }),
            event({ id: 'round-2', type: 'round_started', message: 'Round 2 begins.', overrides: {} })
        ];

        const summary = deriveCurrentTurnSummaryModel({
            snapshot: { ...planningSnapshot(), round: 2 },
            localPlayerId: 'alice-session',
            events,
            lang: 'en'
        });

        expect(summary.stats).toEqual([
            '0/2 locked',
            '2 waiting',
            'R1 results',
            '1 yours',
            '1 castle'
        ]);
    });

    it('classifies timeline entries for reveal, personal, party, castle, and result rows', () => {
        const personal = event({
            id: 'search',
            type: 'player_searched',
            message: 'Alice searched.',
            overrides: {
                animationCue: { type: 'search_altar', playerId: 'alice-session', roomId: 'entrance' }
            }
        });
        const party = event({
            id: 'move',
            type: 'player_moved',
            message: 'Bob moved.',
            overrides: {
                animationCue: { type: 'camera_move', playerId: 'bob-session', roomId: 'hallway' }
            }
        });

        expect(turnTimelineCategory(event({ id: 'reveal', type: 'action_revealed', message: 'Plans revealed.', overrides: {} }), 'alice-session').label)
            .toBe('Reveal');
        expect(turnTimelineCategory(personal, 'alice-session').label).toBe('Your Action');
        expect(turnTimelineCategory(party, 'alice-session').label).toBe('Party Action');
        expect(turnTimelineCategory(event({ id: 'noise', type: 'noise_pulse', message: 'The ruin hears noise.', overrides: {} }), 'alice-session').label)
            .toBe('Castle Reaction');
        expect(turnTimelineCategory(event({ id: 'round', type: 'round_started', message: 'Round 2 begins.', overrides: {} }), 'alice-session').label)
            .toBe('Result');
        expect(isPersonalEvent(personal, 'alice-session')).toBe(true);
    });

    it('summarizes the review phase before the next turn starts', () => {
        const summary = deriveCurrentTurnSummaryModel({
            snapshot: {
                ...planningSnapshot(),
                phase: 'review',
                submittedPlayerIds: [],
                events: [
                    event({ id: 'reveal', type: 'action_revealed', message: 'Round 1 actions are revealed.', overrides: {} }),
                    event({
                        id: 'move',
                        type: 'player_moved',
                        message: 'Alice moved to Hallway.',
                        overrides: {
                            animationCue: { type: 'camera_move', playerId: 'alice-session', roomId: 'hallway' }
                        }
                    })
                ]
            },
            localPlayerId: 'alice-session',
            events: [],
            lang: 'en'
        });

        expect(summary.copy).toMatchObject({
            kind: 'watching',
            eyebrow: 'Round 1',
            title: 'Plans revealed',
            detail: 'Watch each hunter\'s action before the next turn begins.'
        });
    });

    it('names the winner when the expedition is finished', () => {
        const snapshot: RelicPublicSnapshot = {
            ...planningSnapshot(),
            phase: 'finished',
            winnerIds: ['alice-session']
        };

        const summary = deriveCurrentTurnSummaryModel({
            snapshot,
            localPlayerId: 'alice-session',
            events: [],
            lang: 'en'
        });

        expect(summary.copy).toMatchObject({
            kind: 'finished',
            title: 'Expedition complete',
            detail: 'Alice claimed the Heart Relic.'
        });
    });
});

function planningSnapshot(): RelicPublicSnapshot {
    return toPublicRelicSnapshot(planningState());
}

function planningState(): RelicGameState {
    let state = createRelicGame('game-1', 'room-1', NOW);
    state = join({ state: state, senderId: 'alice-session', username: 'Alice', characterId: 'kael-ironstride', now: NOW + 1 });
    state = join({ state: state, senderId: 'bob-session', username: 'Bob', characterId: 'nyra-vale', now: NOW + 2 });
    return requireRelicCommandApplied(applyRelicCommand(
        state,
        {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'start-expedition',
            gameId: 'game-1',
            username: 'Alice'
        },
        { presentPlayerIds: ['alice-session'], senderId: 'alice-session', now: NOW + 3 }
    )).state;
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
        { presentPlayerIds: [senderId], senderId, now: now }
    )).state;
}

function event(
    { id, type, message, overrides }: RelicTestEventInput
): RelicEvent {
    return {
        id,
        round: 1,
        type,
        message,
        tone: 'mystery',
        createdAtEpochMs: NOW,
        ...overrides
    };
}
