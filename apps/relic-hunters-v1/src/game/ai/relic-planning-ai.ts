import {
    computeRelicPlanningAiSuggestion,
    RELIC_PLANNING_AI_PROMPT,
    RELIC_PLANNING_AI_SCHEMA_ID,
    RELIC_PLANNING_AI_SCHEMA_VERSION,
    RELIC_PLANNING_AI_SUGGESTION_SCHEMA,
    type RelicActionInput,
    type RelicEvent,
    type RelicPlanningAiContext,
    type RelicPlanningAiContextAction,
    type RelicPlanningAiSuggestedAction,
    type RelicPlanningAiSuggestion,
    type RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import {
    createRallarAiMockProvider,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonResult
} from '@shared/rallar-ai/mod.ts';
import type { ActionDraft, RelicActionOption, RelicGameViewModel } from '../game-view-model.ts';
import type { Lang } from '../lang.ts';
import type { SceneObjective } from '../scene/objectives.ts';

export const RELIC_PLANNING_AI_PROPOSAL_LIMIT = 6;
export const RELIC_PLANNING_AI_PROPOSAL_TTL_MS = 5 * 60_000;

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

/** The request as it crosses the wire: without `signal`, and always naming its id and the revision it was asked at. */
export interface RelicPlanningAiRequest
    extends Omit<RallarAiJsonRequest<RelicPlanningAiContext>, 'signal' | 'requestId' | 'baseStateRevision'> {
    readonly requestId: string;
    readonly baseStateRevision: string;
}

export function createRelicPlanningAiRequest({
    context,
    baseStateRevision,
    dedupeKey,
    requestId
}: Readonly<{
    context: RelicPlanningAiContext;
    baseStateRevision: string;
    dedupeKey: string;
    requestId?: string;
}>): RelicPlanningAiRequest {
    return {
        requestId: requestId ?? `relic-planning:${dedupeKey}`,
        schemaId: RELIC_PLANNING_AI_SCHEMA_ID,
        schemaVersion: RELIC_PLANNING_AI_SCHEMA_VERSION,
        schema: RELIC_PLANNING_AI_SUGGESTION_SCHEMA,
        prompt: RELIC_PLANNING_AI_PROMPT,
        // The context the request carries is the one its JSON wire form decodes to: absent fields, never undefined ones.
        context: JSON.parse(JSON.stringify(context)),
        baseStateRevision,
        dedupeKey,
        maxOutputTokens: 220,
        temperature: 0.2,
        timeoutMs: 5_000
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

export function createRelicPlanningAiMockProvider(): RallarAiJsonProvider {
    return createRallarAiMockProvider({
        providerId: 'relic-planning-mock',
        modelId: 'deterministic-planning-companion-v1',
        value: (request: RallarAiJsonRequest<RelicPlanningAiContext>) =>
            computeRelicPlanningAiSuggestion(request.context as RelicPlanningAiContext)
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
    return {
        kind: action.kind,
        ...(action.targetRoomId === undefined ? {} : { targetRoomId: action.targetRoomId }),
        ...(action.targetPlayerId === undefined ? {} : { targetPlayerId: action.targetPlayerId })
    };
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
