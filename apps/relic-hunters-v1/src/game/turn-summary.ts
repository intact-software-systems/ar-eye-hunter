import type {
    RelicEvent,
    RelicPlayer,
    RelicPublicSnapshot,
} from '@relic-hunters/mod.ts';
import type { Lang } from './lang.ts';

export type TurnSummaryKind = 'empty' | 'lobby' | 'planning' | 'locked' | 'watching' | 'finished';

export type TurnSummaryCopy = Readonly<{
    kind: TurnSummaryKind;
    eyebrow: string;
    title: string;
    detail: string;
}>;

export type CurrentTurnSummaryModel = Readonly<{
    copy: TurnSummaryCopy;
    stats: readonly string[];
}>;

export type TurnTimelineCategory = Readonly<{
    kind: 'your' | 'party' | 'castle' | 'result' | 'reveal';
    label: string;
}>;

export function deriveCurrentTurnSummaryModel({
    snapshot,
    localPlayerId,
    events,
    lang,
}: Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    events: readonly RelicEvent[];
    lang: Lang;
}>): CurrentTurnSummaryModel {
    const activePlayers = snapshot?.players.filter((player) => !player.escaped && !player.defeated) ?? [];
    const submittedCount = snapshot?.submittedPlayerIds.length ?? 0;
    const waitingCount = Math.max(0, activePlayers.length - submittedCount);
    const localPlayer = snapshot?.players.find((player) => player.playerId === localPlayerId);
    const localSubmitted = !!localPlayerId && !!snapshot?.submittedPlayerIds.includes(localPlayerId);
    const lastTurnRound = [...events].reverse().find(isTurnTimelineEvent)?.round;
    const lastRoundEvents = lastTurnRound === undefined
        ? []
        : events.filter((event) => event.round === lastTurnRound && isTurnTimelineEvent(event));
    const personalCount = lastRoundEvents.filter((event) => isPersonalEvent(event, localPlayerId)).length;
    const castleCount = lastRoundEvents.filter((event) =>
        turnTimelineCategory(event, localPlayerId).kind === 'castle'
    ).length;
    const stats = [
        `${submittedCount}/${activePlayers.length} locked`,
        `${waitingCount} waiting`,
        ...(lastTurnRound !== undefined ? [`R${lastTurnRound} results`] : []),
        ...(personalCount > 0 ? [`${personalCount} yours`] : []),
        ...(castleCount > 0 ? [`${castleCount} castle`] : []),
    ];

    return {
        copy: deriveCurrentTurnSummaryCopy({
            snapshot,
            localPlayer,
            localSubmitted,
            waitingCount,
            lang,
        }),
        stats,
    };
}

function deriveCurrentTurnSummaryCopy({
    snapshot,
    localPlayer,
    localSubmitted,
    waitingCount,
    lang,
}: Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayer?: RelicPlayer;
    localSubmitted: boolean;
    waitingCount: number;
    lang: Lang;
}>): TurnSummaryCopy {
    if (!snapshot) {
        return {
            kind: 'empty',
            eyebrow: lang === 'no' ? 'Ingen ekspedisjon' : 'No Expedition',
            title: lang === 'no' ? 'Velg et rom' : 'Choose a room',
            detail: lang === 'no'
                ? 'Opprett eller bli med i et Relic Hunters-rom.'
                : 'Create or join a Relic Hunters room to start the loop.',
        };
    }

    if (snapshot.phase === 'lobby') {
        return {
            kind: 'lobby',
            eyebrow: lang === 'no' ? 'Lobby' : 'Lobby',
            title: lang === 'no' ? 'Samle ekspedisjonen' : 'Gather the expedition',
            detail: lang === 'no'
                ? 'Bli med som jeger, vent på rommedlemmer, og la Vokteren starte.'
                : 'Join as a hunter, wait for room members, then the Keeper starts.',
        };
    }

    if (snapshot.phase === 'finished') {
        const winnerNames = snapshot.winnerIds
            .map((id) => snapshot.players.find((player) => player.playerId === id)?.username)
            .filter(Boolean)
            .join(', ');
        return {
            kind: 'finished',
            eyebrow: lang === 'no' ? 'Resultat' : 'Result',
            title: lang === 'no' ? 'Ekspedisjonen er over' : 'Expedition complete',
            detail: winnerNames
                ? (lang === 'no'
                    ? `${winnerNames} tok Hjerterelikkiet.`
                    : `${winnerNames} claimed the Heart Relic.`)
                : (lang === 'no' ? 'Ruinen har stilnet.' : 'The ruin has gone quiet.'),
        };
    }

    if (snapshot.phase === 'review') {
        return {
            kind: 'watching',
            eyebrow: lang === 'no' ? `Runde ${snapshot.round}` : `Round ${snapshot.round}`,
            title: lang === 'no' ? 'Planene avsløres' : 'Plans revealed',
            detail: lang === 'no'
                ? 'Se hver jegers handling før neste runde starter.'
                : "Watch each hunter's action before the next turn begins.",
        };
    }

    if (!localPlayer) {
        return {
            kind: 'watching',
            eyebrow: lang === 'no' ? 'Tilskuer' : 'Watching',
            title: lang === 'no' ? 'Ekspedisjonen er i gang' : 'Expedition in progress',
            detail: lang === 'no'
                ? 'Nye jegere kan ikke bli med etter at jakten har startet.'
                : 'Late joins are closed after the hunt starts.',
        };
    }

    if (localPlayer.escaped || localPlayer.defeated) {
        return {
            kind: 'watching',
            eyebrow: lang === 'no' ? 'Din runde' : 'Your Run',
            title: localPlayer.escaped
                ? (lang === 'no' ? 'Du unnslapp' : 'You escaped')
                : (lang === 'no' ? 'Du er ute' : 'You are down'),
            detail: lang === 'no'
                ? 'Følg tidslinjen mens resten av ekspedisjonen avslutter.'
                : 'Follow the timeline while the remaining hunters finish.',
        };
    }

    if (localSubmitted) {
        return {
            kind: 'locked',
            eyebrow: lang === 'no' ? 'Plan låst' : 'Plan Locked',
            title: lang === 'no' ? 'Planen din er låst' : 'Your plan is locked',
            detail: waitingCount > 0
                ? (lang === 'no'
                    ? `Venter på ${waitingCount} jeger${waitingCount === 1 ? '' : 'e'}.`
                    : `Waiting for ${waitingCount} hunter${waitingCount === 1 ? '' : 's'} to lock a plan.`)
                : (lang === 'no'
                    ? 'Alle planer er låst. Ruinen svarer snart.'
                    : 'All plans are locked. The castle is about to answer.'),
        };
    }

    return {
        kind: 'planning',
        eyebrow: lang === 'no' ? `Runde ${snapshot.round}` : `Round ${snapshot.round}`,
        title: lang === 'no' ? 'Velg én plan' : 'Choose one plan',
        detail: lang === 'no'
            ? 'Velg Flytt, Søk, Stjel eller Unnslipp. Alle planer løses samtidig.'
            : 'Pick Move, Search, Steal, or Escape. All plans resolve together.',
    };
}

export function isTurnTimelineEvent(event: RelicEvent): boolean {
    return isTurnResultEvent(event) ||
        event.type === 'action_revealed' ||
        event.type === 'round_started' ||
        event.type === 'game_finished';
}

export function turnTimelineCategory(
    event: RelicEvent,
    localPlayerId: string | undefined,
): TurnTimelineCategory {
    if (event.type === 'action_revealed') {
        return { kind: 'reveal', label: 'Reveal' };
    }
    if (event.type === 'round_started' || event.type === 'game_finished') {
        return { kind: 'result', label: 'Result' };
    }
    if (
        event.type === 'noise_pulse' ||
        event.type === 'player_damaged' ||
        event.type === 'room_unstable' ||
        event.type === 'room_collapsed'
    ) {
        return { kind: 'castle', label: 'Castle Reaction' };
    }
    if (isPersonalEvent(event, localPlayerId)) {
        return { kind: 'your', label: 'Your Action' };
    }
    return { kind: 'party', label: 'Party Action' };
}

export function isTurnResultEvent(event: RelicEvent): boolean {
    switch (event.type) {
        case 'player_moved':
        case 'player_searched':
        case 'relic_found':
        case 'steal_succeeded':
        case 'steal_failed':
        case 'escape_failed':
        case 'player_escaped':
        case 'noise_pulse':
        case 'player_damaged':
        case 'room_unstable':
        case 'room_collapsed':
            return true;
        default:
            return false;
    }
}

export function isPersonalEvent(event: RelicEvent, localPlayerId: string | undefined): boolean {
    if (!localPlayerId) return false;
    return event.animationCue?.playerId === localPlayerId ||
        event.animationCue?.targetPlayerId === localPlayerId;
}
