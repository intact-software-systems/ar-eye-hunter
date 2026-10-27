import {
    isRelicPlanningAiActionLegal,
    type RelicPlanningAiConfidence,
    type RelicPlanningAiContext,
    type RelicPlanningAiSuggestedAction,
    type RelicPlanningAiSuggestion
} from './planning-ai.ts';

export function computeRelicPlanningAiSuggestion(context: RelicPlanningAiContext): RelicPlanningAiSuggestion {
    const action = computeFirstLegalAction(context);
    if (!action) {
        return {
            headline: 'Hold and read the room',
            rationale: 'No clean legal plan is visible, so avoid inventing a move.',
            risks: context.warnings.slice(0, 3).map((warning) => warning.message),
            confidence: 'low'
        };
    }

    return {
        headline: computeHeadline(action, context),
        action,
        rationale: computeRationale(action, context),
        risks: computeRisks(action, context),
        confidence: computeConfidence(action, context)
    };
}

function computeFirstLegalAction(
    context: RelicPlanningAiContext
): RelicPlanningAiSuggestedAction | undefined {
    if (context.sceneRecommendation && isRelicPlanningAiActionLegal(context.sceneRecommendation, context)) {
        return context.sceneRecommendation;
    }

    if (
        isRelicPlanningAiActionLegal({ kind: 'escape' }, context) &&
        ((context.localPlayer?.relicCount ?? 0) > 0 || context.roundsLeft <= 2)
    ) {
        return { kind: 'escape' };
    }

    if (
        isRelicPlanningAiActionLegal({ kind: 'search' }, context) &&
        context.currentRoom &&
        !context.currentRoom.investigated
    ) {
        return { kind: 'search' };
    }

    const firstMove = context.moveTargets[0];
    if (firstMove && isRelicPlanningAiActionLegal({ kind: 'move', targetRoomId: firstMove.roomId }, context)) {
        return { kind: 'move', targetRoomId: firstMove.roomId };
    }

    const relicCarrier = context.stealTargets.find((target) => target.relicCount > 0) ??
        context.stealTargets[0];
    if (
        relicCarrier && isRelicPlanningAiActionLegal({ kind: 'steal', targetPlayerId: relicCarrier.playerId }, context)
    ) {
        return { kind: 'steal', targetPlayerId: relicCarrier.playerId };
    }

    return undefined;
}

function computeHeadline(action: RelicPlanningAiSuggestedAction, context: RelicPlanningAiContext): string {
    if (action.kind === 'move') {
        const target = context.moveTargets.find((candidate) => candidate.roomId === action.targetRoomId);
        return `Move toward ${target?.name ?? 'the next room'}`;
    }
    if (action.kind === 'search') {
        return context.currentRoom
            ? `Search ${context.currentRoom.name}`
            : 'Search for a clue';
    }
    if (action.kind === 'steal') {
        const target = context.stealTargets.find((candidate) => candidate.playerId === action.targetPlayerId);
        return `Pressure ${target?.username ?? 'a rival hunter'}`;
    }
    return 'Bank the run';
}

function computeRationale(action: RelicPlanningAiSuggestedAction, context: RelicPlanningAiContext): string {
    if (action.kind === 'move') {
        const target = context.moveTargets.find((candidate) => candidate.roomId === action.targetRoomId);
        if (target?.relicSignal) {
            return `${target.name} has the strongest visible relic signal among legal routes.`;
        }
        return target?.exitDistance !== undefined
            ? `${target.name} keeps a legal route open and is ${target.exitDistance} step${
                target.exitDistance === 1 ? '' : 's'
            } from the Exit.`
            : 'Moving keeps the expedition from stalling in the current room.';
    }
    if (action.kind === 'search') {
        return context.currentRoom?.investigated
            ? 'The room has prior intel, but Search remains legal if the party wants to confirm it.'
            : 'The current room has no resolved investigation in the visible journal.';
    }
    if (action.kind === 'steal') {
        const target = context.stealTargets.find((candidate) => candidate.playerId === action.targetPlayerId);
        return target
            ? `${target.username} is in reach with ${target.relicCount} relic${target.relicCount === 1 ? '' : 's'}.`
            : 'A rival hunter is in reach this turn.';
    }
    return 'Escaping is the only way to make carried relic points safe.';
}

function computeRisks(action: RelicPlanningAiSuggestedAction, context: RelicPlanningAiContext): readonly string[] {
    const risks = context.warnings.slice(0, 2).map((warning) => warning.message);
    if (action.kind === 'search' && context.currentRoom?.unstable) {
        risks.push('Searching in an unstable room may invite more damage.');
    }
    if (action.kind === 'steal') {
        risks.push('Steal is loud and can fail even when a target is present.');
    }
    if (action.kind === 'move' && context.roundsLeft <= 2) {
        risks.push('There are very few rounds left to reach the Exit.');
    }
    return risks.slice(0, 3);
}

function computeConfidence(
    action: RelicPlanningAiSuggestedAction,
    context: RelicPlanningAiContext
): RelicPlanningAiConfidence {
    if (context.warnings.some((warning) => warning.severity === 'danger')) {
        return 'medium';
    }
    if (action.kind === 'escape' || context.sceneRecommendation?.kind === action.kind) {
        return 'high';
    }
    return 'medium';
}
