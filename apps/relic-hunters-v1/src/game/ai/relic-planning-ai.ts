import type {
    RelicActionInput,
    RelicActionKind,
    RelicEvent,
    RelicPlayer,
    RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import {
    createRallarAiMockProvider,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonResult,
    type RallarAiJsonSchema
} from '@shared/rallar-ai/mod.ts';
import type { ActionDraft, RelicActionOption, RelicGameViewModel } from '../game-view-model.ts';
import type { Lang } from '../lang.ts';
import type { SceneObjective } from '../scene/objectives.ts';

export const RELIC_PLANNING_AI_SCHEMA_ID = 'relic-hunters.planning-companion';
export const RELIC_PLANNING_AI_SCHEMA_VERSION = '1';
export const RELIC_PLANNING_AI_PROPOSAL_LIMIT = 6;
export const RELIC_PLANNING_AI_PROPOSAL_TTL_MS = 5 * 60_000;

const HEADLINE_MAX_LENGTH = 80;
const RATIONALE_MAX_LENGTH = 240;
const RISK_MAX_LENGTH = 120;

export type RelicPlanningAiConfidence = 'low' | 'medium' | 'high';

export type RelicPlanningAiSuggestedAction = Readonly<{
    kind: RelicActionKind;
    targetRoomId?: string;
    targetPlayerId?: string;
}>;

export type RelicPlanningAiSuggestion = Readonly<{
    headline: string;
    action?: RelicPlanningAiSuggestedAction;
    rationale: string;
    risks: readonly string[];
    confidence: RelicPlanningAiConfidence;
}>;

export type RelicPlanningAiContextAction = Readonly<{
    kind: RelicActionKind;
    label: string;
    description: string;
    legal: boolean;
    blocker?: string;
    consequence: Readonly<{
        text: string;
        status: string;
    }>;
}>;

export type RelicPlanningAiContext = Readonly<{
    schema: 'relic-planning-ai-context-v1';
    lang: Lang;
    roomId: string;
    phase: RelicPublicSnapshot['phase'];
    round: number;
    roundsLeft: number;
    turn: Readonly<{
        activePlayerCount: number;
        submittedPlayerCount: number;
        waitingPlayerCount: number;
        localSubmitted: boolean;
    }>;
    localPlayer?: Readonly<{
        username: string;
        health: number;
        score: number;
        relicCount: number;
        escaped: boolean;
        defeated: boolean;
    }>;
    currentRoom?: Readonly<{
        id: string;
        name: string;
        kind: string;
        unstable: boolean;
        collapsed: boolean;
        investigated: boolean;
    }>;
    objective: string;
    sceneRecommendation?: RelicPlanningAiSuggestedAction;
    currentDraft: RelicPlanningAiSuggestedAction;
    actionOptions: readonly RelicPlanningAiContextAction[];
    moveTargets: readonly Readonly<{
        roomId: string;
        name: string;
        kind: string;
        exitDistance?: number;
        relicSignal: boolean;
        unstable: boolean;
        collapsed: boolean;
    }>[];
    stealTargets: readonly Readonly<{
        playerId: string;
        username: string;
        health: number;
        score: number;
        relicCount: number;
    }>[];
    warnings: readonly Readonly<{
        kind: string;
        severity: string;
        message: string;
    }>[];
    knownInvestigations: readonly Readonly<{
        roomName: string;
        result: string;
        summary: string;
        hint: string;
        danger?: string;
        revealedRoomName?: string;
    }>[];
    recentEvents: readonly Readonly<{
        round: number;
        type: string;
        message: string;
        tone?: string;
    }>[];
}>;

export type RelicPlanningAiProposal = Readonly<{
    result: RallarAiJsonResult<RelicPlanningAiSuggestion>;
    senderId?: string;
    receivedAtEpochMs: number;
    local: boolean;
}>;

export type RelicPlanningAiStatus =
    | 'disabled'
    | 'idle'
    | 'generating'
    | 'ready'
    | 'stale'
    | 'error'
    | 'unavailable';

export type RelicPlanningAiState = Readonly<{
    status: RelicPlanningAiStatus;
    canGenerate: boolean;
    error?: string;
    localProposal?: RelicPlanningAiProposal;
    proposals: readonly RelicPlanningAiProposal[];
}>;

export type RelicPlanningAiSuggestionValidation =
    | Readonly<{ ok: true; suggestion: RelicPlanningAiSuggestion; }>
    | Readonly<{ ok: false; reason: string; }>;

export const RELIC_PLANNING_AI_SUGGESTION_SCHEMA: RallarAiJsonSchema = {
    type: 'object',
    required: ['headline', 'rationale', 'risks', 'confidence'],
    additionalProperties: false,
    properties: {
        headline: { type: 'string', minLength: 1, maxLength: HEADLINE_MAX_LENGTH },
        action: {
            type: 'object',
            required: ['kind'],
            additionalProperties: false,
            properties: {
                kind: {
                    type: 'string',
                    enum: ['move', 'search', 'steal', 'escape']
                },
                targetRoomId: { type: 'string', minLength: 1, maxLength: 80 },
                targetPlayerId: { type: 'string', minLength: 1, maxLength: 120 }
            }
        },
        rationale: { type: 'string', minLength: 1, maxLength: RATIONALE_MAX_LENGTH },
        risks: {
            type: 'array',
            maxItems: 3,
            items: { type: 'string', minLength: 1, maxLength: RISK_MAX_LENGTH }
        },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
    }
};

export function buildRelicPlanningAiContext({
    snapshot,
    localPlayerId,
    draft,
    lang,
    viewModel,
    sceneObjective
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    localPlayerId?: string;
    draft: ActionDraft;
    lang: Lang;
    viewModel: RelicGameViewModel;
    sceneObjective?: SceneObjective;
}>): RelicPlanningAiContext {
    const currentPlayer = viewModel.currentPlayer;
    const currentRoom = viewModel.currentRoom;
    const exitDistances = relicExitDistances(snapshot.map);

    return {
        schema: 'relic-planning-ai-context-v1',
        lang,
        roomId: snapshot.roomId,
        phase: snapshot.phase,
        round: snapshot.round,
        roundsLeft: snapshot.maxRounds - snapshot.round + 1,
        turn: {
            activePlayerCount: viewModel.turnStatus.activePlayerCount,
            submittedPlayerCount: viewModel.turnStatus.submittedPlayerCount,
            waitingPlayerCount: viewModel.turnStatus.waitingPlayerCount,
            localSubmitted: !!(
                localPlayerId && snapshot.submittedPlayerIds.includes(localPlayerId)
            )
        },
        localPlayer: currentPlayer
            ? {
                username: currentPlayer.username,
                health: currentPlayer.health,
                score: currentPlayer.score,
                relicCount: currentPlayer.relicIds.length,
                escaped: currentPlayer.escaped,
                defeated: currentPlayer.defeated
            }
            : undefined,
        currentRoom: currentRoom
            ? {
                id: currentRoom.id,
                name: currentRoom.name,
                kind: currentRoom.kind,
                unstable: !!currentRoom.unstable,
                collapsed: !!currentRoom.collapsed,
                investigated: roomInvestigated(snapshot, currentRoom.id)
            }
            : undefined,
        objective: viewModel.objective,
        sceneRecommendation: toPlanningAiAction(sceneObjective?.recommendedAction),
        currentDraft: toPlanningAiAction(draft) ?? { kind: draft.kind },
        actionOptions: Object.values(viewModel.actionOptions).map(toContextActionOption),
        moveTargets: viewModel.moveTargets.map((roomId) => {
            const room = snapshot.map.find((candidate) => candidate.id === roomId);
            return {
                roomId,
                name: room?.name ?? roomId,
                kind: room?.kind ?? 'room',
                exitDistance: exitDistances.get(roomId),
                relicSignal: hasUnfoundRelicSignal(snapshot, roomId),
                unstable: !!room?.unstable,
                collapsed: !!room?.collapsed
            };
        }),
        stealTargets: viewModel.stealTargets.map((player) => ({
            playerId: player.playerId,
            username: player.username,
            health: player.health,
            score: player.score,
            relicCount: player.relicIds.length
        })),
        warnings: viewModel.warnings.map((warning) => ({
            kind: warning.kind,
            severity: warning.severity,
            message: warning.message
        })),
        knownInvestigations: snapshot.roomInvestigations.slice(-8).map((investigation) => {
            const room = snapshot.map.find((candidate) => candidate.id === investigation.roomId);
            const revealedRoom = investigation.revealedRoomId
                ? snapshot.map.find((candidate) => candidate.id === investigation.revealedRoomId)
                : undefined;
            return {
                roomName: room?.name ?? 'Unknown room',
                result: investigation.result,
                summary: investigation.summary,
                hint: investigation.hint,
                danger: investigation.danger,
                revealedRoomName: revealedRoom?.name
            };
        }),
        recentEvents: snapshot.events.slice(-6).map((event: RelicEvent) => ({
            round: event.round,
            type: event.type,
            message: event.message,
            tone: event.tone
        }))
    };
}

export function createRelicPlanningAiRequest({
    context,
    baseStateRevision,
    dedupeKey,
    requestId,
    signal
}: Readonly<{
    context: RelicPlanningAiContext;
    baseStateRevision: string;
    dedupeKey: string;
    requestId?: string;
    signal?: AbortSignal;
}>): RallarAiJsonRequest<RelicPlanningAiContext> {
    return {
        requestId: requestId ?? `relic-planning:${dedupeKey}`,
        schemaId: RELIC_PLANNING_AI_SCHEMA_ID,
        schemaVersion: RELIC_PLANNING_AI_SCHEMA_VERSION,
        schema: RELIC_PLANNING_AI_SUGGESTION_SCHEMA,
        prompt: [
            'You are a Relic Hunters planning companion.',
            'Return one concise JSON suggestion for the local player.',
            'Only recommend legal actions and target ids from the context.',
            'Do not claim hidden relic names, exact hidden values, or unrevealed secret locations.',
            'Never submit actions or imply that the suggestion is authoritative.'
        ].join(' '),
        context: stripUndefinedValues(context) as RelicPlanningAiContext,
        baseStateRevision,
        dedupeKey,
        maxOutputTokens: 220,
        temperature: 0.2,
        timeoutMs: 5_000,
        signal
    };
}

export function relicPlanningAiBaseStateRevision({
    snapshot,
    localPlayerId,
    draft
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    localPlayerId?: string;
    draft: ActionDraft;
}>): string {
    const localRoomId = snapshot.players.find((player) => player.playerId === localPlayerId)?.roomId;
    return [
        'relic-planning-ai-v1',
        snapshot.roomId,
        String(snapshot.updatedAtEpochMs),
        snapshot.phase,
        String(snapshot.round),
        [...snapshot.submittedPlayerIds].sort().join(','),
        localPlayerId ?? 'anonymous',
        localRoomId ?? 'no-room',
        relicPlanningAiDraftKey(draft)
    ].join('|');
}

export function relicPlanningAiDedupeKey({
    snapshot,
    localPlayerId,
    baseStateRevision
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    localPlayerId?: string;
    baseStateRevision: string;
}>): string {
    return [
        'relic-planning-ai',
        snapshot.roomId,
        String(snapshot.round),
        localPlayerId ?? 'anonymous',
        baseStateRevision
    ].join(':');
}

export function relicPlanningAiDraftKey(draft: ActionDraft): string {
    return [
        draft.kind,
        draft.targetRoomId ?? '',
        draft.targetPlayerId ?? ''
    ].join(':');
}

export function canGenerateRelicPlanningAi(
    snapshot: RelicPublicSnapshot | undefined,
    localPlayerId: string | undefined
): boolean {
    const player = snapshot?.players.find((candidate) => candidate.playerId === localPlayerId);
    return !!snapshot &&
        snapshot.phase === 'planning' &&
        !!player &&
        !player.escaped &&
        !player.defeated &&
        !snapshot.submittedPlayerIds.includes(player.playerId);
}

export function validateRelicPlanningAiSuggestion(
    value: unknown,
    context: RelicPlanningAiContext
): RelicPlanningAiSuggestionValidation {
    if (!isRecord(value)) {
        return { ok: false, reason: 'Suggestion must be an object.' };
    }

    const headline = readCappedString(value.headline, 'headline', HEADLINE_MAX_LENGTH);
    if (!headline.ok) {
        return headline;
    }
    const rationale = readCappedString(value.rationale, 'rationale', RATIONALE_MAX_LENGTH);
    if (!rationale.ok) {
        return rationale;
    }
    if (!Array.isArray(value.risks) || value.risks.length > 3) {
        return { ok: false, reason: 'Risks must contain at most 3 entries.' };
    }
    const risks: string[] = [];
    for (const risk of value.risks) {
        const next = readCappedString(risk, 'risk', RISK_MAX_LENGTH);
        if (!next.ok) {
            return next;
        }
        risks.push(next.value);
    }
    if (!isConfidence(value.confidence)) {
        return { ok: false, reason: 'Confidence must be low, medium, or high.' };
    }

    const action = value.action === undefined
        ? undefined
        : readSuggestedAction(value.action);
    if (action && !action.ok) {
        return action;
    }
    if (action?.ok && !isActionLegalInContext(action.value, context)) {
        return { ok: false, reason: 'Suggested action is not legal for this turn.' };
    }

    return {
        ok: true,
        suggestion: {
            headline: headline.value,
            action: action?.ok ? action.value : undefined,
            rationale: rationale.value,
            risks,
            confidence: value.confidence
        }
    };
}

export function createRelicPlanningAiMockProvider(): RallarAiJsonProvider {
    return createRallarAiMockProvider({
        providerId: 'relic-planning-mock',
        modelId: 'deterministic-planning-companion-v1',
        value: (request: RallarAiJsonRequest<RelicPlanningAiContext>) =>
            mockRelicPlanningSuggestion(
                request.context as RelicPlanningAiContext
            )
    });
}

export function addRelicPlanningAiProposal({
    proposals,
    result,
    senderId,
    receivedAtEpochMs,
    local,
    messageRoomId,
    currentRoomId,
    currentBaseStateRevision,
    revisionMode = 'shared'
}: Readonly<{
    proposals: readonly RelicPlanningAiProposal[];
    result: RallarAiJsonResult<RelicPlanningAiSuggestion>;
    senderId?: string;
    receivedAtEpochMs: number;
    local: boolean;
    messageRoomId?: string;
    currentRoomId?: string;
    currentBaseStateRevision?: string;
    revisionMode?: 'exact' | 'shared';
}>): readonly RelicPlanningAiProposal[] {
    const pruned = pruneRelicPlanningAiProposals(proposals, receivedAtEpochMs);
    if (messageRoomId && currentRoomId && messageRoomId !== currentRoomId) {
        return pruned;
    }
    if (
        result.schemaId !== RELIC_PLANNING_AI_SCHEMA_ID ||
        result.schemaVersion !== RELIC_PLANNING_AI_SCHEMA_VERSION ||
        !result.validation.ok
    ) {
        return pruned;
    }
    if (
        currentBaseStateRevision &&
        !isRelicPlanningAiRevisionCurrent(
            result.baseStateRevision,
            currentBaseStateRevision,
            revisionMode
        )
    ) {
        return pruned;
    }

    const dedupeId = result.dedupeKey ?? result.generationId;
    return [
        {
            result,
            senderId,
            receivedAtEpochMs,
            local
        },
        ...pruned.filter((proposal) =>
            proposal.result.generationId !== result.generationId &&
            (proposal.result.dedupeKey ?? proposal.result.generationId) !== dedupeId
        )
    ]
        .sort((left, right) => right.receivedAtEpochMs - left.receivedAtEpochMs)
        .slice(0, RELIC_PLANNING_AI_PROPOSAL_LIMIT);
}

export function pruneRelicPlanningAiProposals(
    proposals: readonly RelicPlanningAiProposal[],
    nowEpochMs: number
): readonly RelicPlanningAiProposal[] {
    return proposals
        .filter((proposal) => nowEpochMs - proposal.receivedAtEpochMs <= RELIC_PLANNING_AI_PROPOSAL_TTL_MS)
        .sort((left, right) => right.receivedAtEpochMs - left.receivedAtEpochMs)
        .slice(0, RELIC_PLANNING_AI_PROPOSAL_LIMIT);
}

export function isRelicPlanningAiRevisionCurrent(
    candidateRevision: string | undefined,
    currentRevision: string,
    mode: 'exact' | 'shared' = 'exact'
): boolean {
    if (!candidateRevision) {
        return false;
    }
    if (mode === 'exact') {
        return candidateRevision === currentRevision;
    }
    return sharedRevisionPrefix(candidateRevision) === sharedRevisionPrefix(currentRevision);
}

function mockRelicPlanningSuggestion(
    context: RelicPlanningAiContext
): RelicPlanningAiSuggestion {
    const action = firstLegalMockAction(context);
    if (!action) {
        return {
            headline: 'Hold and read the room',
            rationale: 'No clean legal plan is visible, so avoid inventing a move.',
            risks: context.warnings.slice(0, 3).map((warning) => warning.message),
            confidence: 'low'
        };
    }

    return {
        headline: headlineForAction(action, context),
        action,
        rationale: rationaleForAction(action, context),
        risks: risksForAction(action, context),
        confidence: confidenceForAction(action, context)
    };
}

function firstLegalMockAction(
    context: RelicPlanningAiContext
): RelicPlanningAiSuggestedAction | undefined {
    if (
        context.sceneRecommendation &&
        isActionLegalInContext(context.sceneRecommendation, context)
    ) {
        return context.sceneRecommendation;
    }

    if (
        isActionLegalInContext({ kind: 'escape' }, context) &&
        ((context.localPlayer?.relicCount ?? 0) > 0 || context.roundsLeft <= 2)
    ) {
        return { kind: 'escape' };
    }

    if (
        isActionLegalInContext({ kind: 'search' }, context) &&
        context.currentRoom &&
        !context.currentRoom.investigated
    ) {
        return { kind: 'search' };
    }

    const firstMove = context.moveTargets[0];
    if (firstMove && isActionLegalInContext({ kind: 'move', targetRoomId: firstMove.roomId }, context)) {
        return { kind: 'move', targetRoomId: firstMove.roomId };
    }

    const relicCarrier = context.stealTargets.find((target) => target.relicCount > 0) ??
        context.stealTargets[0];
    if (
        relicCarrier &&
        isActionLegalInContext({ kind: 'steal', targetPlayerId: relicCarrier.playerId }, context)
    ) {
        return { kind: 'steal', targetPlayerId: relicCarrier.playerId };
    }

    return undefined;
}

function isActionLegalInContext(
    action: RelicPlanningAiSuggestedAction,
    context: RelicPlanningAiContext
): boolean {
    const option = context.actionOptions.find((candidate) => candidate.kind === action.kind);
    if (!option?.legal) {
        return false;
    }
    if (action.kind === 'move') {
        return !!action.targetRoomId &&
            context.moveTargets.some((target) => target.roomId === action.targetRoomId);
    }
    if (action.kind === 'steal') {
        return !!action.targetPlayerId &&
            context.stealTargets.some((target) => target.playerId === action.targetPlayerId);
    }
    return true;
}

function headlineForAction(
    action: RelicPlanningAiSuggestedAction,
    context: RelicPlanningAiContext
): string {
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

function rationaleForAction(
    action: RelicPlanningAiSuggestedAction,
    context: RelicPlanningAiContext
): string {
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

function risksForAction(
    action: RelicPlanningAiSuggestedAction,
    context: RelicPlanningAiContext
): readonly string[] {
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

function confidenceForAction(
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

function toContextActionOption(option: RelicActionOption): RelicPlanningAiContextAction {
    return {
        kind: option.kind,
        label: option.info.label,
        description: option.info.description,
        legal: option.legal,
        blocker: option.blocker,
        consequence: {
            text: option.consequence.text,
            status: option.consequence.status
        }
    };
}

function toPlanningAiAction(
    action: RelicActionInput | ActionDraft | undefined
): RelicPlanningAiSuggestedAction | undefined {
    if (!action) {
        return undefined;
    }
    return stripUndefinedValues({
        kind: action.kind,
        targetRoomId: action.targetRoomId,
        targetPlayerId: action.targetPlayerId
    }) as RelicPlanningAiSuggestedAction;
}

function readSuggestedAction(
    value: unknown
): Readonly<{ ok: true; value: RelicPlanningAiSuggestedAction; }> | Readonly<{ ok: false; reason: string; }> {
    if (!isRecord(value) || !isRelicActionKind(value.kind)) {
        return { ok: false, reason: 'Action kind is invalid.' };
    }
    return {
        ok: true,
        value: {
            kind: value.kind,
            targetRoomId: typeof value.targetRoomId === 'string'
                ? value.targetRoomId
                : undefined,
            targetPlayerId: typeof value.targetPlayerId === 'string'
                ? value.targetPlayerId
                : undefined
        }
    };
}

function readCappedString(
    value: unknown,
    field: string,
    maxLength: number
): Readonly<{ ok: true; value: string; }> | Readonly<{ ok: false; reason: string; }> {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return { ok: false, reason: `${field} must be a non-empty string.` };
    }
    if (value.length > maxLength) {
        return { ok: false, reason: `${field} is too long.` };
    }
    return { ok: true, value };
}

function isConfidence(value: unknown): value is RelicPlanningAiConfidence {
    return value === 'low' || value === 'medium' || value === 'high';
}

function isRelicActionKind(value: unknown): value is RelicActionKind {
    return value === 'move' ||
        value === 'search' ||
        value === 'steal' ||
        value === 'escape';
}

function roomInvestigated(snapshot: RelicPublicSnapshot, roomId: string): boolean {
    return snapshot.roomInvestigations.some((investigation) => investigation.roomId === roomId) ||
        snapshot.relics.some((relic) =>
            relic.roomId === roomId &&
            (!!relic.foundBy || !!relic.carriedBy || !!relic.escapedBy)
        );
}

function hasUnfoundRelicSignal(
    snapshot: RelicPublicSnapshot,
    roomId: string
): boolean {
    return snapshot.relics.some((relic) =>
        relic.roomId === roomId &&
        !relic.foundBy &&
        !relic.carriedBy &&
        !relic.escapedBy
    );
}

function relicExitDistances(
    map: RelicPublicSnapshot['map']
): Map<string, number> {
    const exit = map.find((room) => room.kind === 'exit');
    const distances = new Map<string, number>();
    if (!exit) {
        return distances;
    }
    const queue: Array<Readonly<{ roomId: string; distance: number; }>> = [
        { roomId: exit.id, distance: 0 }
    ];
    distances.set(exit.id, 0);
    while (queue.length > 0) {
        const current = queue.shift()!;
        const room = map.find((candidate) => candidate.id === current.roomId);
        if (!room) {
            continue;
        }
        for (const neighborId of room.neighbors) {
            if (distances.has(neighborId)) {
                continue;
            }
            const neighbor = map.find((candidate) => candidate.id === neighborId);
            if (!neighbor || neighbor.collapsed) {
                continue;
            }
            distances.set(neighborId, current.distance + 1);
            queue.push({ roomId: neighborId, distance: current.distance + 1 });
        }
    }
    return distances;
}

function sharedRevisionPrefix(revision: string): string {
    return revision.split('|').slice(0, 6).join('|');
}

function stripUndefinedValues(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stripUndefinedValues);
    }
    if (!isRecord(value)) {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .map(([key, entry]) => [key, stripUndefinedValues(entry)])
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
