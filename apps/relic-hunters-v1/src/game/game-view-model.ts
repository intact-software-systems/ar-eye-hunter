import type {
    RelicActionInput,
    RelicActionKind,
    RelicEvent,
    RelicPlayer,
    RelicPublicSnapshot,
} from '@relic-hunters/mod.ts';
import { legalMoveTargets } from '@relic-hunters/mod.ts';
import { UI, type Lang } from './lang.ts';

export type ActionDraft = Readonly<{
    kind: RelicActionInput['kind'];
    targetRoomId?: string;
    targetPlayerId?: string;
}>;

export type ActionConsequenceStatus = 'ok' | 'warn' | 'block';

export type ActionConsequence = Readonly<{
    text: string;
    status: ActionConsequenceStatus;
}>;

export type RelicActionInfo = Readonly<{
    label: string;
    noise: string;
    description: string;
}>;

export type RelicActionOption = Readonly<{
    kind: RelicActionKind;
    info: RelicActionInfo;
    consequence: ActionConsequence;
    legal: boolean;
    blocker?: string;
}>;

export type RelicProgressSummary = Readonly<{
    relics: string;
    escape: string;
}>;

export type RelicTurnStatus = Readonly<{
    phase?: RelicPublicSnapshot['phase'];
    activePlayerCount: number;
    submittedPlayerCount: number;
    waitingPlayerCount: number;
    roundsLeft?: number;
    canSubmit: boolean;
    isLocked: boolean;
}>;

export type RelicGameWarning = Readonly<{
    kind: 'low-health' | 'round-limit' | 'round-noise' | 'search-danger';
    severity: 'info' | 'warning' | 'danger';
    message: string;
}>;

export type RelicGameViewModel = Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    currentPlayer?: RelicPlayer;
    currentRoom?: RelicPublicSnapshot['map'][number];
    moveTargets: readonly string[];
    stealTargets: readonly RelicPlayer[];
    progress?: RelicProgressSummary;
    objective: string;
    actionInfo: RelicActionInfo;
    actionOptions: Readonly<Record<RelicActionKind, RelicActionOption>>;
    submitBlocker?: string;
    turnStatus: RelicTurnStatus;
    warnings: readonly RelicGameWarning[];
    lowHealthWarning?: RelicGameWarning;
    roundLimitWarning?: RelicGameWarning;
    actionBriefDanger?: string;
    isAdmin: boolean;
    roundNoiseCount: number;
}>;

export const RELIC_ACTION_KINDS: readonly RelicActionKind[] = [
    'move',
    'search',
    'steal',
    'escape',
];

export const RELIC_ACTION_INFO: Readonly<Record<RelicActionKind, RelicActionInfo>> = {
    move: {
        label: 'Move',
        noise: 'quiet',
        description: 'Step into an adjacent room to reach relics or race toward the exit.',
    },
    search: {
        label: 'Search',
        noise: 'noisy',
        description: 'Look for relics in this room. Searching creates danger but wins games.',
    },
    steal: {
        label: 'Steal',
        noise: 'loud',
        description: 'Take a relic from another hunter in your room. Failed attempts still make noise.',
    },
    escape: {
        label: 'Escape',
        noise: 'silent',
        description: 'Leave from the Exit with your relics. Escaped hunters keep their score safe.',
    },
};

export function deriveRelicGameViewModel({
                                             snapshot,
                                             localPlayerId,
                                             draft,
                                             lang,
                                             revealedEvents = [],
                                         }: Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    draft: ActionDraft;
    lang: Lang;
    revealedEvents?: readonly RelicEvent[];
}>): RelicGameViewModel {
    const currentPlayer = snapshot?.players.find((player) =>
        player.playerId === localPlayerId
    );
    const currentRoom = snapshot?.map.find((room) =>
        room.id === currentPlayer?.roomId
    );
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
    const submitBlocker = snapshot && currentPlayer
        ? actionBlocker(snapshot, currentPlayer, draft, moveTargets, stealTargets, currentRoom)
        : undefined;
    const turnStatus = deriveTurnStatus(snapshot, currentPlayer, submitBlocker);
    const warnings = deriveWarnings(snapshot, currentPlayer, currentRoom, draft, revealedEvents);

    const adminPlayerId = snapshot?.adminPlayerId ?? snapshot?.players[0]?.playerId;

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
        actionOptions: deriveActionOptions(snapshot, currentPlayer, currentRoom, moveTargets, stealTargets),
        submitBlocker,
        turnStatus,
        warnings,
        lowHealthWarning: warnings.find((warning) => warning.kind === 'low-health'),
        roundLimitWarning: warnings.find((warning) => warning.kind === 'round-limit'),
        actionBriefDanger: warnings.find((warning) => warning.kind === 'search-danger')?.message,
        isAdmin: currentPlayer?.playerId === adminPlayerId,
        roundNoiseCount: roundNoiseCount(snapshot, revealedEvents),
    };
}

function deriveActionOptions(
    snapshot: RelicPublicSnapshot | undefined,
    currentPlayer: RelicPlayer | undefined,
    currentRoom: RelicPublicSnapshot['map'][number] | undefined,
    moveTargets: readonly string[],
    stealTargets: readonly RelicPlayer[],
): Readonly<Record<RelicActionKind, RelicActionOption>> {
    return Object.fromEntries(RELIC_ACTION_KINDS.map((kind) => {
        const blocker = snapshot && currentPlayer
            ? actionBlocker(snapshot, currentPlayer, { kind }, moveTargets, stealTargets, currentRoom)
            : undefined;
        return [
            kind,
            {
                kind,
                info: RELIC_ACTION_INFO[kind],
                consequence: actionConsequence(
                    kind,
                    snapshot,
                    currentRoom,
                    moveTargets,
                    stealTargets,
                    currentPlayer,
                ),
                legal: !blocker,
                blocker,
            },
        ];
    })) as Record<RelicActionKind, RelicActionOption>;
}

function deriveTurnStatus(
    snapshot: RelicPublicSnapshot | undefined,
    currentPlayer: RelicPlayer | undefined,
    submitBlocker: string | undefined,
): RelicTurnStatus {
    const activeCount = snapshot ? activePlayerCount(snapshot) : 0;
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
        isLocked,
    };
}

function deriveWarnings(
    snapshot: RelicPublicSnapshot | undefined,
    currentPlayer: RelicPlayer | undefined,
    currentRoom: RelicPublicSnapshot['map'][number] | undefined,
    draft: ActionDraft,
    revealedEvents: readonly RelicEvent[],
): readonly RelicGameWarning[] {
    if (!snapshot) return [];

    const warnings: RelicGameWarning[] = [];
    if (currentPlayer?.health === 1 && !currentPlayer.escaped && !currentPlayer.defeated) {
        warnings.push({
            kind: 'low-health',
            severity: 'danger',
            message: 'One hit from defeat - move carefully.',
        });
    }

    if (snapshot.maxRounds - snapshot.round <= 1) {
        warnings.push({
            kind: 'round-limit',
            severity: snapshot.round >= snapshot.maxRounds ? 'danger' : 'warning',
            message: snapshot.round >= snapshot.maxRounds
                ? 'Final round - escape or be lost to the ruin.'
                : `${snapshot.maxRounds - snapshot.round} round${snapshot.maxRounds - snapshot.round === 1 ? '' : 's'} remaining - the ruin closes soon.`,
        });
    }

    const danger = currentRoom && draft.kind === 'search'
        ? snapshot.roomInvestigations?.find((investigation) =>
            investigation.roomId === currentRoom.id
        )?.danger
        : undefined;
    if (danger) {
        warnings.push({
            kind: 'search-danger',
            severity: 'warning',
            message: danger,
        });
    }

    const noiseCount = roundNoiseCount(snapshot, revealedEvents);
    if (noiseCount >= 3) {
        warnings.push({
            kind: 'round-noise',
            severity: 'warning',
            message: 'Rooms destabilising',
        });
    }

    return warnings;
}

export function actionConsequence(
    kind: RelicActionKind,
    snapshot: RelicPublicSnapshot | undefined,
    currentRoom: RelicPublicSnapshot['map'][number] | undefined,
    moveTargets: readonly string[],
    stealTargets: readonly RelicPlayer[],
    currentPlayer: RelicPlayer | undefined,
): ActionConsequence {
    if (!snapshot || !currentPlayer) return { text: '-', status: 'ok' };
    switch (kind) {
        case 'move':
            return moveTargets.length > 0
                ? { text: `${moveTargets.length} path${moveTargets.length === 1 ? '' : 's'} open`, status: 'ok' }
                : { text: 'all paths blocked', status: 'block' };
        case 'search': {
            const searched = snapshot.roomInvestigations?.some(
                (investigation) => investigation.roomId === currentPlayer.roomId,
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

export function toProgress(
    snapshot: RelicPublicSnapshot,
    localPlayerId: string | undefined,
): RelicProgressSummary {
    const foundCount = snapshot.relics.filter((relic) => relic.foundBy).length;
    const escapedCount = snapshot.players.filter((player) => player.escaped).length;
    const localPlayer = snapshot.players.find((player) => player.playerId === localPlayerId);

    return {
        relics: `${foundCount}/${snapshot.relics.length}`,
        escape: localPlayer?.escaped
            ? 'safe'
            : `${escapedCount}/${Math.max(snapshot.players.length, 1)}`,
    };
}

export function toObjective(
    snapshot: RelicPublicSnapshot,
    currentPlayer: RelicPlayer | undefined,
    lang: Lang,
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

    if (currentPlayer.escaped) {
        return u.objectiveEscaped;
    }

    if (currentPlayer.defeated) {
        return u.objectiveDefeated;
    }

    if (snapshot.submittedPlayerIds.includes(currentPlayer.playerId)) {
        const waiting = activePlayerCount(snapshot) - snapshot.submittedPlayerIds.length;
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

export function activePlayerCount(snapshot: RelicPublicSnapshot): number {
    return snapshot.players.filter((player) => !player.escaped && !player.defeated).length;
}

export function actionBlocker(
    snapshot: RelicPublicSnapshot,
    player: RelicPlayer,
    draft: ActionDraft,
    moveTargets: readonly string[],
    stealTargets: readonly RelicPlayer[],
    currentRoom?: RelicPublicSnapshot['map'][number],
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

function roundNoiseCount(
    snapshot: RelicPublicSnapshot | undefined,
    revealedEvents: readonly RelicEvent[],
): number {
    return snapshot
        ? revealedEvents.filter(
            (event) => event.round === snapshot.round - 1 && event.type === 'noise_pulse',
        ).length
        : 0;
}
