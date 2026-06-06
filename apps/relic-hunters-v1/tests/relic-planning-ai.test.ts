import { describe, expect, it } from 'vitest';
import {
    RELIC_PROTOCOL_VERSION,
    applyRelicCommand,
    createRelicGame,
    toPublicRelicSnapshot,
    type RelicGameState,
    type RelicPublicSnapshot,
} from '@relic-hunters/mod.ts';
import { transitionRallarAiResultLifecycle } from '@shared/rallar-ai/mod.ts';
import { deriveRelicGameViewModel } from '../src/game/game-view-model.ts';
import { deriveSceneObjective } from '../src/game/scene/objectives.ts';
import {
    addRelicPlanningAiProposal,
    buildRelicPlanningAiContext,
    createRelicPlanningAiMockProvider,
    createRelicPlanningAiRequest,
    relicPlanningAiBaseStateRevision,
    relicPlanningAiDedupeKey,
    validateRelicPlanningAiSuggestion,
} from '../src/game/ai/relic-planning-ai.ts';

const NOW = 1_700_000_000_000;

describe('Relic planning browser AI', () => {
    it('builds a compact context without raw hidden relic details', () => {
        const snapshot = planningSnapshot();
        const context = contextFor(snapshot);
        const serialized = JSON.stringify(context);

        expect(context.phase).toBe('planning');
        expect(context.actionOptions.map((option) => option.kind)).toEqual([
            'move',
            'search',
            'steal',
            'escape',
        ]);
        expect(context.moveTargets.some((target) => target.relicSignal)).toBe(true);
        expect(serialized).not.toContain('Golden Idol');
        expect(serialized).not.toContain('Cursed Mask');
        expect(serialized).not.toContain('sun-disk');
    });

    it('includes public warnings, objective, and recent events', () => {
        const base = planningSnapshot();
        const snapshot: RelicPublicSnapshot = {
            ...base,
            round: base.maxRounds,
            players: base.players.map((player) =>
                player.playerId === 'alice-session'
                    ? { ...player, health: 1 }
                    : player
            ),
        };
        const context = contextFor(snapshot);

        expect(context.objective).toContain('Find relics');
        expect(context.warnings.map((warning) => warning.kind)).toEqual([
            'low-health',
            'round-limit',
        ]);
        expect(context.recentEvents.length).toBeGreaterThan(0);
    });

    it('creates stable request revision and dedupe keys', () => {
        const snapshot = planningSnapshot();
        const draft = { kind: 'move' as const, targetRoomId: 'storage' };
        const context = contextFor(snapshot, draft);
        const revision = relicPlanningAiBaseStateRevision({
            snapshot,
            localPlayerId: 'alice-session',
            draft,
        });
        const dedupeKey = relicPlanningAiDedupeKey({
            snapshot,
            localPlayerId: 'alice-session',
            baseStateRevision: revision,
        });
        const request = createRelicPlanningAiRequest({
            context,
            baseStateRevision: revision,
            dedupeKey,
        });

        expect(request.baseStateRevision).toBe(revision);
        expect(request.dedupeKey).toBe(dedupeKey);
        expect(request.requestId).toContain(dedupeKey);
    });

    it('mock provider proposes a deterministic legal suggestion', async () => {
        const snapshot = planningSnapshot();
        const context = contextFor(snapshot);
        const revision = relicPlanningAiBaseStateRevision({
            snapshot,
            localPlayerId: 'alice-session',
            draft: { kind: 'search' },
        });
        const provider = createRelicPlanningAiMockProvider();
        const result = await provider.generateJson(createRelicPlanningAiRequest({
            context,
            baseStateRevision: revision,
            dedupeKey: 'dedupe-1',
        }));

        expect(result.validation.ok).toBe(true);
        expect(result.value.action).toEqual({
            kind: 'move',
            targetRoomId: 'storage',
        });
        expect(validateRelicPlanningAiSuggestion(result.value, context).ok).toBe(true);
    });

    it('rejects illegal targets and text beyond caps', () => {
        const context = contextFor(planningSnapshot());

        expect(validateRelicPlanningAiSuggestion({
            headline: 'Bad move',
            action: { kind: 'move', targetRoomId: 'monster' },
            rationale: 'Monster is not adjacent from the entrance.',
            risks: [],
            confidence: 'medium',
        }, context)).toMatchObject({ ok: false });

        expect(validateRelicPlanningAiSuggestion({
            headline: 'x'.repeat(81),
            action: { kind: 'search' },
            rationale: 'Too much headline.',
            risks: [],
            confidence: 'medium',
        }, context)).toMatchObject({ ok: false });
    });

    it('de-dupes proposals and ignores wrong-room, stale, and expired entries', async () => {
        const snapshot = planningSnapshot();
        const context = contextFor(snapshot);
        const revision = relicPlanningAiBaseStateRevision({
            snapshot,
            localPlayerId: 'alice-session',
            draft: { kind: 'search' },
        });
        const result = transitionRallarAiResultLifecycle(
            await createRelicPlanningAiMockProvider().generateJson(createRelicPlanningAiRequest({
                context,
                baseStateRevision: revision,
                dedupeKey: 'room-1:r1:alice',
            })),
            'proposed',
        );

        const accepted = addRelicPlanningAiProposal({
            proposals: [],
            result,
            senderId: 'alice-session',
            receivedAtEpochMs: NOW,
            local: false,
            messageRoomId: 'room-1',
            currentRoomId: 'room-1',
            currentBaseStateRevision: revision,
            revisionMode: 'shared',
        });
        const duplicate = addRelicPlanningAiProposal({
            proposals: accepted,
            result,
            senderId: 'alice-session',
            receivedAtEpochMs: NOW + 1,
            local: false,
            messageRoomId: 'room-1',
            currentRoomId: 'room-1',
            currentBaseStateRevision: revision,
            revisionMode: 'shared',
        });
        const wrongRoom = addRelicPlanningAiProposal({
            proposals: duplicate,
            result,
            senderId: 'alice-session',
            receivedAtEpochMs: NOW + 2,
            local: false,
            messageRoomId: 'room-2',
            currentRoomId: 'room-1',
            currentBaseStateRevision: revision,
            revisionMode: 'shared',
        });
        const staleRevision = revision.replace('|planning|', '|review|');
        const stale = addRelicPlanningAiProposal({
            proposals: wrongRoom,
            result: { ...result, baseStateRevision: staleRevision },
            senderId: 'alice-session',
            receivedAtEpochMs: NOW + 3,
            local: false,
            messageRoomId: 'room-1',
            currentRoomId: 'room-1',
            currentBaseStateRevision: revision,
            revisionMode: 'shared',
        });
        const expired = addRelicPlanningAiProposal({
            proposals: stale,
            result,
            senderId: 'alice-session',
            receivedAtEpochMs: NOW + 301_000,
            local: false,
            messageRoomId: 'room-1',
            currentRoomId: 'room-1',
            currentBaseStateRevision: revision,
            revisionMode: 'shared',
        });

        expect(accepted).toHaveLength(1);
        expect(duplicate).toHaveLength(1);
        expect(wrongRoom).toHaveLength(1);
        expect(stale).toHaveLength(1);
        expect(expired).toHaveLength(1);
        expect(expired[0].receivedAtEpochMs).toBe(NOW + 301_000);
    });
});

function contextFor(
    snapshot: RelicPublicSnapshot,
    draft = { kind: 'search' as const },
) {
    const viewModel = deriveRelicGameViewModel({
        snapshot,
        localPlayerId: 'alice-session',
        draft,
        lang: 'en',
    });
    return buildRelicPlanningAiContext({
        snapshot,
        localPlayerId: 'alice-session',
        draft,
        lang: 'en',
        viewModel,
        sceneObjective: deriveSceneObjective({
            snapshot,
            localPlayerId: 'alice-session',
        }),
    });
}

function planningSnapshot(): RelicPublicSnapshot {
    let state: RelicGameState = createRelicGame('room-1', 'room-1', NOW);
    state = applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username: 'Alice',
        characterId: 'kael-ironstride',
    }, {
        senderId: 'alice-session',
        now: () => NOW + 1,
    }).state;
    state = applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username: 'Bob',
        characterId: 'nyra-vale',
    }, {
        senderId: 'bob-session',
        now: () => NOW + 2,
    }).state;
    state = applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'start-expedition',
        gameId: 'room-1',
        username: 'Alice',
    }, {
        senderId: 'alice-session',
        now: () => NOW + 3,
    }).state;
    return toPublicRelicSnapshot(state);
}
