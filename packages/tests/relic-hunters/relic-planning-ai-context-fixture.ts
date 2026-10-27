import type { RelicPlanningAiContext, RelicPlanningAiContextAction } from '@relic-hunters/mod.ts';

export function createRelicPlanningAiActionOption(
    kind: RelicPlanningAiContextAction['kind'],
    legal: boolean
): RelicPlanningAiContextAction {
    return {
        kind,
        label: kind,
        description: `The ${kind} action.`,
        legal,
        ...(legal ? {} : { blocker: 'Not this turn.' }),
        consequence: { text: `You ${kind}.`, status: legal ? 'ready' : 'blocked' }
    };
}

/** Alice's first planning turn in the Entrance: Hallway is adjacent, Bob carries a relic, escape is not yet legal. */
export const RELIC_PLANNING_AI_CONTEXT_FIXTURE: RelicPlanningAiContext = {
    schema: 'relic-planning-ai-context-v1',
    lang: 'en',
    roomId: 'room-1',
    phase: 'planning',
    round: 1,
    roundsLeft: 8,
    turn: { activePlayerCount: 2, submittedPlayerCount: 0, waitingPlayerCount: 2, localSubmitted: false },
    localPlayer: { username: 'Alice', health: 3, score: 0, relicCount: 0, escaped: false, defeated: false },
    currentRoom: { id: 'entrance', name: 'Entrance', kind: 'entrance', unstable: false, collapsed: false, investigated: false },
    objective: 'Find relics and reach the Exit.',
    currentDraft: { kind: 'search' },
    actionOptions: [
        createRelicPlanningAiActionOption('move', true),
        createRelicPlanningAiActionOption('search', true),
        createRelicPlanningAiActionOption('steal', true),
        createRelicPlanningAiActionOption('escape', false)
    ],
    moveTargets: [
        { roomId: 'hallway', name: 'Hallway', kind: 'room', exitDistance: 2, relicSignal: false, unstable: false, collapsed: false }
    ],
    stealTargets: [{ playerId: 'bob-session', username: 'Bob', health: 3, score: 0, relicCount: 1 }],
    warnings: [{ kind: 'low-health', severity: 'warning', message: 'Low health' }],
    knownInvestigations: [],
    recentEvents: [{ round: 1, type: 'round-started', message: 'Alice started the expedition.', tone: 'info' }]
};
