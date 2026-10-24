import type {
    RelicActionInput,
    RelicActionKind,
    RelicEvent,
    RelicPlayer,
    RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import { legalMoveTargets } from '@relic-hunters/mod.ts';
import { UI, type Lang } from './lang.ts';

export interface ActionDraft {
    readonly kind: RelicActionInput['kind'];
    readonly targetRoomId?: string;
    readonly targetPlayerId?: string;
}

export type ActionConsequenceStatus = 'ok' | 'warn' | 'block';

export interface ActionConsequence {
    readonly text: string;
    readonly status: ActionConsequenceStatus;
}

export interface RelicActionInfo {
    readonly label: string;
    readonly noise: string;
    readonly description: string;
}

export interface RelicActionOption {
    readonly kind: RelicActionKind;
    readonly info: RelicActionInfo;
    readonly consequence: ActionConsequence;
    readonly legal: boolean;
    readonly blocker?: string;
}

export interface RelicProgressSummary {
    readonly relics: string;
    readonly escape: string;
}

export interface RelicTurnStatus {
    readonly phase?: RelicPublicSnapshot['phase'];
    readonly activePlayerCount: number;
    readonly submittedPlayerCount: number;
    readonly waitingPlayerCount: number;
    readonly roundsLeft?: number;
    readonly canSubmit: boolean;
    readonly isLocked: boolean;
}

export interface RelicGameWarning {
    readonly kind: 'low-health' | 'round-limit' | 'round-noise' | 'search-danger';
    readonly severity: 'info' | 'warning' | 'danger';
    readonly message: string;
}

export interface RelicGameViewModel {
    readonly snapshot?: RelicPublicSnapshot;
    readonly localPlayerId?: string;
    readonly currentPlayer?: RelicPlayer;
    readonly currentRoom?: RelicPublicSnapshot['map'][number];
    readonly moveTargets: readonly string[];
    readonly stealTargets: readonly RelicPlayer[];
    readonly progress?: RelicProgressSummary;
    readonly objective: string;
    readonly actionInfo: RelicActionInfo;
    readonly actionOptions: Readonly<Record<RelicActionKind, RelicActionOption>>;
    readonly submitBlocker?: string;
    readonly turnStatus: RelicTurnStatus;
    readonly warnings: readonly RelicGameWarning[];
    readonly lowHealthWarning?: RelicGameWarning;
    readonly roundLimitWarning?: RelicGameWarning;
    readonly actionBriefDanger?: string;
    readonly isAdmin: boolean;
    readonly roundNoiseCount: number;
}

export interface RelicGameViewModelInput {
    readonly snapshot: RelicPublicSnapshot | undefined;
    readonly localPlayerId: string | undefined;
    readonly draft: ActionDraft;
    readonly lang: Lang;
    readonly revealedEvents: readonly RelicEvent[];
}

interface RelicActionContext {
    readonly snapshot: RelicPublicSnapshot | undefined;
    readonly currentPlayer: RelicPlayer | undefined;
    readonly currentRoom: RelicPublicSnapshot['map'][number] | undefined;
    readonly moveTargets: readonly string[];
    readonly stealTargets: readonly RelicPlayer[];
}

interface RelicActionOptionInput extends RelicActionContext {
    readonly kind: RelicActionKind;
}

interface RelicActionValidationInput {
    readonly snapshot: RelicPublicSnapshot;
    readonly player: RelicPlayer;
    readonly draft: ActionDraft;
    readonly moveTargets: readonly string[];
    readonly stealTargets: readonly RelicPlayer[];
    readonly currentRoom: RelicPublicSnapshot['map'][number] | undefined;
}

interface RelicWarningsInput {
    readonly snapshot: RelicPublicSnapshot | undefined;
    readonly currentPlayer: RelicPlayer | undefined;
    readonly currentRoom: RelicPublicSnapshot['map'][number] | undefined;
    readonly draft: ActionDraft;
    readonly revealedEvents: readonly RelicEvent[];
}

export const RELIC_ACTION_KINDS: readonly RelicActionKind[] = [
    'move',
    'search',
    'steal',
    'escape'
];

export const RELIC_ACTION_INFO: Readonly<Record<RelicActionKind, RelicActionInfo>> = {
    move: {
        label: 'Move',
        noise: 'quiet',
        description: 'Step into an adjacent room to reach relics or race toward the exit.'
    },
    search: {
        label: 'Search',
        noise: 'noisy',
        description: 'Look for relics in this room. Searching creates danger but wins games.'
    },
    steal: {
        label: 'Steal',
        noise: 'loud',
        description: 'Take a relic from another hunter in your room. Failed attempts still make noise.'
    },
    escape: {
        label: 'Escape',
        noise: 'silent',
        description: 'Leave from the Exit with your relics. Escaped hunters keep their score safe.'
    }
};

export function computeRelicGameViewModel({
    snapshot,
    localPlayerId,
    draft,
    lang,
    revealedEvents
}: RelicGameViewModelInput): RelicGameViewModel {
    const currentPlayer = snapshot?.players.find((player) => player.playerId === localPlayerId);
    const currentRoom = snapshot?.map.find((room) => room.id === currentPlayer?.roomId);
    const moveTargets = snapshot && currentPlayer
        ? legalMoveTargets(snapshot, currentPlayer)
        : [];
    const stealTargets = snapshot?.players.filter((player) =>
        currentPlayer &&
        player.playerId !== currentPlayer.playerId &&
        player.roomId === currentPlayer.roomId &&
        !player.escaped &&
        !player.defeated
    ) ?? [];
    const actionContext = { snapshot, currentPlayer, currentRoom, moveTargets, stealTargets };
    const submitBlocker = snapshot && currentPlayer
        ? computeActionBlocker({ ...actionContext, snapshot, player: currentPlayer, draft })
        : undefined;
    const turnStatus = computeTurnStatus(snapshot, currentPlayer, submitBlocker);
    const warnings = computeWarnings({
        snapshot,
        currentPlayer,
        currentRoom,
        draft,
        revealedEvents
    });

    const adminPlayerId = snapshot?.adminPlayerId;

    return {
        snapshot,
        localPlayerId,
        currentPlayer,
        currentRoom,
        moveTargets,
        stealTargets,
        progress: snapshot ? toProgress(snapshot, localPlayerId) : undefined,
        objective: snapshot
            ? toObjective(snapshot, currentPlayer, lang)
            : 'Create or join a room to begin the expedition.',
        actionInfo: RELIC_ACTION_INFO[draft.kind],
        actionOptions: computeActionOptions(actionContext),
        submitBlocker,
        turnStatus,
        warnings,
        lowHealthWarning: warnings.find((warning) => warning.kind === 'low-health'),
        roundLimitWarning: warnings.find((warning) => warning.kind === 'round-limit'),
        actionBriefDanger: warnings.find((warning) => warning.kind === 'search-danger')?.message,
        isAdmin: currentPlayer !== undefined && currentPlayer.playerId === adminPlayerId,
        roundNoiseCount: computeRoundNoiseCount(snapshot, revealedEvents)
    };
}

function computeActionOptions(actionContext: RelicActionContext): Readonly<Record<RelicActionKind, RelicActionOption>> {
    return {
        move: computeActionOption({ ...actionContext, kind: 'move' }),
        search: computeActionOption({ ...actionContext, kind: 'search' }),
        steal: computeActionOption({ ...actionContext, kind: 'steal' }),
        escape: computeActionOption({ ...actionContext, kind: 'escape' })
    };
}

function computeActionOption(actionContext: RelicActionOptionInput): RelicActionOption {
    const { snapshot, currentPlayer, kind } = actionContext;
    const blocker = snapshot && currentPlayer
        ? computeActionBlocker({ ...actionContext, snapshot, player: currentPlayer, draft: { kind } })
        : undefined;
    return {
        kind,
        info: RELIC_ACTION_INFO[kind],
        consequence: computeActionConsequence(actionContext),
        legal: !blocker,
        blocker
    };
}

function computeTurnStatus(
    snapshot: RelicPublicSnapshot | undefined,
    currentPlayer: RelicPlayer | undefined,
    submitBlocker: string | undefined
): RelicTurnStatus {
    const activeCount = snapshot ? computeActivePlayerCount(snapshot) : 0;
    const submittedCount = snapshot?.submittedPlayerIds.length ?? 0;
    const isLocked = !!(currentPlayer && snapshot &&
        snapshot.submittedPlayerIds.includes(currentPlayer.playerId));

    return {
        phase: snapshot?.phase,
        activePlayerCount: activeCount,
        submittedPlayerCount: submittedCount,
        waitingPlayerCount: Math.max(0, activeCount - submittedCount),
        roundsLeft: snapshot ? snapshot.maxRounds - snapshot.round + 1 : undefined,
        canSubmit: !!snapshot &&
            snapshot.phase === 'planning' &&
            !!currentPlayer &&
            !isLocked &&
            !submitBlocker,
        isLocked
    };
}

function computeWarnings(
    { snapshot, currentPlayer, currentRoom, draft, revealedEvents }: RelicWarningsInput
): readonly RelicGameWarning[] {
    if (!snapshot) {
        return [];
    }

    const warnings: RelicGameWarning[] = [];
    if (currentPlayer?.health === 1 && !currentPlayer.escaped && !currentPlayer.defeated) {
        warnings.push({
            kind: 'low-health',
            severity: 'danger',
            message: 'One hit from defeat - move carefully.'
        });
    }

    if (snapshot.maxRounds - snapshot.round <= 1) {
        warnings.push({
            kind: 'round-limit',
            severity: snapshot.round >= snapshot.maxRounds ? 'danger' : 'warning',
            message: snapshot.round >= snapshot.maxRounds
                ? 'Final round - escape or be lost to the ruin.'
                : `${snapshot.maxRounds - snapshot.round} round${
                    snapshot.maxRounds - snapshot.round === 1 ? '' : 's'
                } remaining - the ruin closes soon.`
        });
    }

    const danger = currentRoom && draft.kind === 'search'
        ? snapshot.roomInvestigations.find((investigation) => investigation.roomId === currentRoom.id)?.danger
        : undefined;
    if (danger) {
        warnings.push({
            kind: 'search-danger',
            severity: 'warning',
            message: danger
        });
    }

    const noiseCount = computeRoundNoiseCount(snapshot, revealedEvents);
    if (noiseCount >= 3) {
        warnings.push({
            kind: 'round-noise',
            severity: 'warning',
            message: 'Rooms destabilising'
        });
    }

    return warnings;
}

function computeActionConsequence(
    { kind, snapshot, currentRoom, moveTargets, stealTargets, currentPlayer }: RelicActionOptionInput
): ActionConsequence {
    if (!snapshot || !currentPlayer) {
        return { text: '-', status: 'ok' };
    }
    switch (kind) {
        case 'move':
            return moveTargets.length > 0
                ? { text: `${moveTargets.length} path${moveTargets.length === 1 ? '' : 's'} open`, status: 'ok' }
                : { text: 'all paths blocked', status: 'block' };
        case 'search': {
            const searched = snapshot.roomInvestigations?.some(
                (investigation) => investigation.roomId === currentPlayer.roomId
            );
            return searched
                ? { text: 'already searched here', status: 'warn' }
                : { text: 'room not yet searched', status: 'ok' };
        }
        case 'steal':
            return stealTargets.length > 0
                ? { text: `${stealTargets.length} hunter${stealTargets.length === 1 ? '' : 's'} here`, status: 'ok' }
                : { text: 'no targets here', status: 'block' };
        case 'escape':
            return currentRoom?.kind === 'exit'
                ? { text: 'exit door in reach', status: 'ok' }
                : { text: 'not at exit room', status: 'block' };
    }
}

function toProgress(
    snapshot: RelicPublicSnapshot,
    localPlayerId: string | undefined
): RelicProgressSummary {
    const foundCount = snapshot.relics.filter((relic) => relic.foundBy).length;
    const escapedCount = snapshot.players.filter((player) => player.escaped).length;
    const localPlayer = snapshot.players.find((player) => player.playerId === localPlayerId);

    return {
        relics: `${foundCount}/${snapshot.relics.length}`,
        escape: localPlayer?.escaped
            ? 'safe'
            : `${escapedCount}/${Math.max(snapshot.players.length, 1)}`
    };
}

function toObjective(
    snapshot: RelicPublicSnapshot,
    currentPlayer: RelicPlayer | undefined,
    lang: Lang
): string {
    const u = UI[lang];
    if (snapshot.phase === 'finished') {
        return snapshot.winnerIds.length > 0 ? u.objectiveWon : u.objectiveSilent;
    }

    if (!currentPlayer) {
        return u.objectiveJoin;
    }

    if (snapshot.phase === 'lobby') {
        return u.objectiveLobby;
    }

    if (snapshot.phase === 'review') {
        return lang === 'no'
            ? 'Se planene bli avslørt før neste runde.'
            : 'Watch the revealed plans before the next turn.';
    }

    if (currentPlayer.escaped) {
        return u.objectiveEscaped;
    }

    if (currentPlayer.defeated) {
        return u.objectiveDefeated;
    }

    if (snapshot.submittedPlayerIds.includes(currentPlayer.playerId)) {
        const waiting = computeActivePlayerCount(snapshot) - snapshot.submittedPlayerIds.length;
        return waiting > 0
            ? (lang === 'no'
                ? `Plan låst. Venter på ${waiting} jeger${waiting === 1 ? '' : 'e'}.`
                : `Plan locked. Waiting for ${waiting} hunter${waiting === 1 ? '' : 's'}.`)
            : u.objectiveAllLocked;
    }

    const roundsLeft = snapshot.maxRounds - snapshot.round + 1;
    return lang === 'no'
        ? `Finn relikvier, unnslipp innen ${roundsLeft} runde${roundsLeft === 1 ? '' : 'r'}.`
        : `Find relics, then escape within ${roundsLeft} round${roundsLeft === 1 ? '' : 's'}.`;
}

function computeActivePlayerCount(snapshot: RelicPublicSnapshot): number {
    return snapshot.players.filter((player) => !player.escaped && !player.defeated).length;
}

function computeActionBlocker(
    { snapshot, player, draft, moveTargets, stealTargets, currentRoom }: RelicActionValidationInput
): string | undefined {
    if (snapshot.phase !== 'planning') {
        return 'Start the expedition before locking plans.';
    }

    if (player.escaped) {
        return 'You are already safe outside the ruin.';
    }

    if (player.defeated) {
        return 'You are down and cannot act this expedition.';
    }

    if (draft.kind === 'move' && moveTargets.length === 0) {
        return 'No open adjacent paths from this room.';
    }

    if (draft.kind === 'steal' && stealTargets.length === 0) {
        return 'Steal needs another active hunter in this room.';
    }

    if (draft.kind === 'escape' && currentRoom?.kind !== 'exit') {
        return 'Escape only works from the Exit room.';
    }

    return undefined;
}

function computeRoundNoiseCount(
    snapshot: RelicPublicSnapshot | undefined,
    revealedEvents: readonly RelicEvent[]
): number {
    return snapshot
        ? revealedEvents.filter(
            (event) => event.round === snapshot.round - 1 && event.type === 'noise_pulse'
        ).length
        : 0;
}
