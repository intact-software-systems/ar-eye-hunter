import type {
    RelicEvent,
    RelicEventType,
    RelicPlayer,
    RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import { findRelicCharacter } from '@relic-hunters/mod.ts';
import { useMemo } from 'react';
import { UI, type Lang } from '../lang.ts';
import {
    deriveCurrentTurnSummaryModel,
    isPersonalEvent,
    isTurnTimelineEvent,
    turnTimelineCategory
} from '../turn-summary.ts';

interface RelicTimelineProps {
    readonly snapshot?: RelicPublicSnapshot;
    readonly localPlayerId?: string;
    readonly revealedEvents: readonly RelicEvent[];
    readonly lastEvent?: RelicEvent;
    readonly lang: Lang;
}

export function RelicTimeline({
    snapshot,
    localPlayerId,
    revealedEvents,
    lastEvent,
    lang
}: RelicTimelineProps) {
    const hasPlayers = (snapshot?.players.length ?? 0) > 0;

    return (
        <section className={`bottom-panel${hasPlayers ? '' : ' compact'}`}>
            {hasPlayers && (
                <HunterList
                    players={snapshot?.players ?? []}
                    localPlayerId={localPlayerId}
                    phase={snapshot?.phase}
                    submittedPlayerIds={snapshot?.submittedPlayerIds ?? []}
                    lang={lang}
                />
            )}
            <TurnTimelinePanel
                snapshot={snapshot}
                localPlayerId={localPlayerId}
                events={revealedEvents}
                lastEvent={lastEvent}
                lang={lang}
            />
        </section>
    );
}

interface TurnTimelinePanelProps {
    readonly snapshot?: RelicPublicSnapshot;
    readonly localPlayerId?: string;
    readonly events: readonly RelicEvent[];
    readonly lastEvent?: RelicEvent;
    readonly lang: Lang;
}

function TurnTimelinePanel({
    snapshot,
    localPlayerId,
    events,
    lastEvent,
    lang
}: TurnTimelinePanelProps) {
    return (
        <div className="turn-timeline-panel">
            <CurrentTurnSummary
                snapshot={snapshot}
                localPlayerId={localPlayerId}
                events={events}
                lang={lang}
            />
            <RoundChronicle
                events={events}
                phase={snapshot?.phase}
                lastEvent={lastEvent}
                localPlayerId={localPlayerId}
            />
        </div>
    );
}

interface CurrentTurnSummaryProps {
    readonly snapshot?: RelicPublicSnapshot;
    readonly localPlayerId?: string;
    readonly events: readonly RelicEvent[];
    readonly lang: Lang;
}

function CurrentTurnSummary({
    snapshot,
    localPlayerId,
    events,
    lang
}: CurrentTurnSummaryProps) {
    const summary = deriveCurrentTurnSummaryModel({
        snapshot,
        localPlayerId,
        events,
        lang
    });

    return (
        <section className={`turn-summary turn-summary-${summary.copy.kind}`} aria-label="Current turn summary">
            <div className="turn-summary-copy">
                <span className="panel-label">{summary.copy.eyebrow}</span>
                <strong>{summary.copy.title}</strong>
                <small>{summary.copy.detail}</small>
            </div>
            <div className="turn-summary-stats" aria-label="Turn status">
                {summary.stats.map((stat) => <span key={stat}>{stat}</span>)}
            </div>
        </section>
    );
}

interface RoundChronicleProps {
    readonly events: readonly RelicEvent[];
    readonly phase?: RelicPublicSnapshot['phase'];
    readonly lastEvent?: RelicEvent;
    readonly localPlayerId?: string;
}

function RoundChronicle({
    events,
    phase,
    lastEvent,
    localPlayerId
}: RoundChronicleProps) {
    const roundGroups = useMemo(() => {
        const groups = new Map<number, RelicEvent[]>();
        for (const e of events) {
            if (!isTurnTimelineEvent(e)) {
                continue;
            }
            const list = groups.get(e.round) ?? [];
            list.push(e);
            groups.set(e.round, list);
        }
        return [...groups.entries()]
            .sort((a, b) => b[0] - a[0])
            .slice(0, 3);
    }, [events]);

    return (
        <div className={`chronicle ${toneClass(lastEvent)}`} aria-label="Turn timeline">
            <div className="chronicle-title">
                <span>{phase === 'finished' ? 'Expedition End' : 'Turn Timeline'}</span>
                <strong>{chronicleHeadline(lastEvent, phase)}</strong>
            </div>
            <div className="chronicle-list chronicle-grouped">
                {roundGroups.length > 0
                    ? (
                        roundGroups.map(([round, roundEvents]) => (
                            <div key={round} className="chronicle-round-group">
                                <div className="chronicle-round-header">Round {round}</div>
                                {roundEvents
                                    .slice(-6)
                                    .reverse()
                                    .map((event) => (
                                        <ChronicleEvent key={event.id} event={event} localPlayerId={localPlayerId} />
                                    ))}
                            </div>
                        ))
                    )
                    : (
                        <small className="chronicle-empty">
                            Turn results will appear here as the castle resolves each round.
                        </small>
                    )}
            </div>
        </div>
    );
}

function turnDiffSymbol(type: RelicEventType): string {
    switch (type) {
        case 'player_moved':
            return '→';
        case 'player_searched':
            return '?';
        case 'relic_found':
            return '◆';
        case 'relic_picked_up':
            return '◆';
        case 'steal_succeeded':
            return '^';
        case 'steal_failed':
            return 'x';
        case 'escape_failed':
            return 'x';
        case 'player_escaped':
            return '+';
        case 'player_damaged':
            return '!';
        case 'room_collapsed':
            return '#';
        case 'room_unstable':
            return '~';
        case 'noise_pulse':
            return '~';
        default:
            return '·';
    }
}

interface HunterListProps {
    readonly players: readonly RelicPlayer[];
    readonly localPlayerId?: string;
    readonly phase?: RelicPublicSnapshot['phase'];
    readonly submittedPlayerIds: readonly string[];
    readonly lang: Lang;
}

function HunterList({
    players,
    localPlayerId,
    phase,
    submittedPlayerIds,
    lang
}: HunterListProps) {
    return (
        <div className="hunter-list">
            {players.map((player) => (
                <HunterChip
                    key={player.playerId}
                    player={player}
                    localPlayerId={localPlayerId}
                    phase={phase}
                    submitted={submittedPlayerIds.includes(player.playerId)}
                    lang={lang}
                />
            ))}
        </div>
    );
}

interface HunterChipProps {
    readonly player: RelicPlayer;
    readonly localPlayerId?: string;
    readonly phase?: RelicPublicSnapshot['phase'];
    readonly submitted: boolean;
    readonly lang: Lang;
}

function HunterChip({
    player,
    localPlayerId,
    phase,
    submitted,
    lang
}: HunterChipProps) {
    const character = findRelicCharacter(player.characterId);
    const maxHealth = 3 + (character.healthBonus ?? 0);
    const u = UI[lang];
    const status = player.escaped
        ? 'escaped'
        : player.defeated
        ? 'down'
        : phase === 'planning'
        ? submitted
            ? u.bound
            : u.heedingTheCall
        : player.roomId;
    return (
        <div
            className={[
                'hunter-chip',
                player.playerId === localPlayerId ? 'active' : '',
                submitted ? 'submitted' : '',
                player.defeated ? 'defeated' : ''
            ].filter(Boolean).join(' ')}
        >
            <span
                className="hunter-dot"
                style={{ background: character.colors.accent }}
            />
            <strong>{player.username}</strong>
            <span>{player.score}</span>
            {!player.escaped && !player.defeated && (
                <span className="hunter-chip-health" aria-label={`${player.health} health`}>
                    {Array.from({ length: maxHealth }, (_, i) => (
                        <span
                            key={i}
                            className={`hunter-chip-pip${i >= player.health ? ' empty' : ''}${
                                player.health === 1 && i === 0 ? ' critical' : ''
                            }`}
                        />
                    ))}
                </span>
            )}
            <small>
                {character.role} / {status}
            </small>
        </div>
    );
}

function chronicleHeadline(
    event: RelicEvent | undefined,
    phase: RelicPublicSnapshot['phase'] | undefined
): string {
    if (!event) {
        return phase === 'lobby' ? 'The ruin waits.' : 'Listen for the next echo.';
    }

    switch (event.type) {
        case 'game_waiting':
            return 'The castle holds its breath.';
        case 'player_joined':
            return 'A new hunter enters the ruin.';
        case 'round_started':
            return 'The expedition presses on.';
        case 'action_submitted':
            return 'A plan sealed in silence.';
        case 'action_revealed':
            return 'The fates are set in motion.';
        case 'player_moved':
            return 'Footsteps echo through the dark.';
        case 'player_searched':
            return 'The ruin yields its secrets slowly.';
        case 'relic_found':
            return 'Treasure breaks the silence.';
        case 'relic_picked_up':
            return 'Asset Recovery loses another argument.';
        case 'steal_succeeded':
            return 'Trust is the first casualty.';
        case 'steal_failed':
            return 'Some things resist the taking.';
        case 'escape_failed':
            return 'The castle holds fast.';
        case 'player_escaped':
            return 'Daylight is close.';
        case 'noise_pulse':
            return 'The ruin hears everything.';
        case 'player_damaged':
            return 'The castle draws blood.';
        case 'room_unstable':
            return 'The walls begin to speak.';
        case 'room_collapsed':
            return 'Stone gives way.';
        case 'game_finished':
            return 'The expedition is over.';
        default:
            return event.message;
    }
}

const NARRATOR_LINES: Partial<Record<RelicEventType, readonly string[]>> = {
    game_waiting: ['The ruin holds its breath.'],
    player_joined: ['Another soul answers the call.', 'The expedition grows bolder.'],
    round_started: ['The torches hold their breath.', 'A new round stirs the castle\'s bones.'],
    action_submitted: ['A plan is whispered into the dark.', 'Choices made in silence.'],
    action_revealed: ['Plans unravel in the flickering dark.', 'The castle watches as fates unfold.'],
    player_moved: [
        'Footfalls fade into shadow.',
        'The corridor swallows another hunter.',
        'Stone whispers of passage.'
    ],
    player_searched: [
        'Dust disturbed by desperate hands.',
        'Old secrets resist new fingers.',
        'Every clue costs time.'
    ],
    relic_found: [
        'The ancient stirs. Something answers.',
        'Fortune paid in danger.',
        'Gold gleams where none expected.'
    ],
    relic_picked_up: [
        'A relic changes hands. The paperwork screams quietly.',
        'Asset Management updates its panic forecast.',
        'Someone has stolen company property from destiny.'
    ],
    steal_succeeded: ['Trust collapses in the dark.', 'One hunter\'s prize becomes another\'s.'],
    steal_failed: ['Greed grasps and finds only air.', 'Some things are not so easily taken.'],
    escape_failed: ['The ruin holds fast.', 'The castle will not release you yet.'],
    player_escaped: ['Daylight claims another soul.', 'The ruin loosens its grip.'],
    noise_pulse: [
        'The walls remember every whisper.',
        'Stone carries sound to distant ears.',
        'Something in the dark takes note.'
    ],
    player_damaged: [
        'The castle exacts its toll.',
        'Pain is the ruin\'s oldest currency.',
        'Stone and shadow take their due.'
    ],
    room_unstable: [
        'A crack traces the ceiling like a curse.',
        'The walls breathe wrong.',
        'This room will not last.'
    ],
    room_collapsed: [
        'Dust and darkness swallow the chamber.',
        'What stood for centuries surrenders.',
        'The ruin reclaims what it lent.'
    ],
    game_finished: [
        'The expedition breathes its last.',
        'What was sought is either found or lost forever.'
    ]
};

function narratorLine(event: RelicEvent): string {
    const lines = NARRATOR_LINES[event.type];
    if (!lines || lines.length === 0) {
        return '';
    }
    return lines[event.id.charCodeAt(event.id.length - 1) % lines.length];
}

function toneClass(event: RelicEvent | undefined): string {
    return event?.tone ? `tone-${event.tone}` : 'tone-neutral';
}
interface ChronicleEventProps {
    readonly event: RelicEvent;
    readonly localPlayerId?: string;
}
function ChronicleEvent({ event, localPlayerId }: ChronicleEventProps) {
    const narLine = narratorLine(event);
    const personal = isPersonalEvent(event, localPlayerId);
    const category = turnTimelineCategory(event, localPlayerId);
    return (
        <div
            key={event.id}
            className={`chronicle-entry ${toneClass(event)} ${personal ? 'personal' : ''}`}
        >
            <div className="timeline-entry-meta">
                <span
                    className={`timeline-category timeline-category-${category.kind}`}
                >
                    {category.label}
                </span>
                <span className="timeline-symbol">
                    {turnDiffSymbol(event.type)}
                </span>
            </div>
            {narLine && <em className="narrator-voice">{narLine}</em>}
            <span className="chronicle-message">{event.message}</span>
        </div>
    );
}
