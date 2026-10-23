import type {
    RelicActionInput,
    RelicPlayer,
    RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import { findRelicCharacter } from '@relic-hunters/mod.ts';
import { RELIC_ACTION_KINDS } from '../game-view-model.ts';
import { plural, UI, type Lang } from '../lang.ts';
import type { RelicHuntersRuntime } from '../relic-hunters-runtime.ts';
import { playUiSound } from '../sound.ts';
import type { RelicTurn } from '../use-relic-turn.ts';
import { castleMapExitDistances } from './relic-map.tsx';
import { derivePartyCoordination } from './relic-party.tsx';

interface RelicRoundPlanProps {
    readonly game: RelicHuntersRuntime.Connection;
    readonly turn: RelicTurn;
    readonly lang: Lang;
}

export function RelicRoundPlan({ game, turn, lang }: RelicRoundPlanProps) {
    if (!turn.planning || !game.snapshot || !game.session) {
        return null;
    }
    return (
        <section className="action-command-panel" aria-label="Round plan">
            <TurnPlanStatusCard snapshot={game.snapshot} localPlayerId={game.session.sessionId} />
            {turn.viewModel.turnStatus.isLocked && (
                <LockedPlanCard
                    action={turn.actions.lockedAction}
                    snapshot={game.snapshot}
                    localPlayerId={game.session.sessionId}
                />
            )}
            <RelicActionPicker turn={turn} />
            <RelicActionBrief turn={turn} />
            <RelicPlanTargets game={game} turn={turn} lang={lang} />
            <RelicRoundWarnings turn={turn} />
            {turn.timeRemainingMs !== null && <RoundTimer timeRemainingMs={turn.timeRemainingMs} lang={lang} />}
            <RelicPlanSubmission game={game} turn={turn} lang={lang} />
        </section>
    );
}

interface RelicTurnPanelProps {
    readonly turn: RelicTurn;
}

function RelicActionPicker({ turn }: RelicTurnPanelProps) {
    return (
        <div className="action-picker">
            {RELIC_ACTION_KINDS.map((kind, index) => {
                const option = turn.viewModel.actionOptions[kind];
                const urgent = kind === 'escape' && turn.viewModel.currentRoom?.kind === 'exit' &&
                    (turn.viewModel.currentPlayer?.relicIds.length ?? 0) > 0;
                return (
                    <button
                        type="button"
                        key={kind}
                        className={[
                            turn.selection.draft.kind === kind ? 'active' : '',
                            urgent ? 'action-escape-urgent' : '',
                            !option.legal ? 'action-option-blocked' : ''
                        ].filter(Boolean).join(' ')}
                        aria-pressed={turn.selection.draft.kind === kind}
                        onClick={() => turn.actions.selectKind(kind)}
                    >
                        <span>
                            {option.info.label}
                            <kbd className="action-key">{index + 1}</kbd>
                        </span>
                        <small>{option.info.noise}</small>
                        <em className={`action-cq action-cq-${option.consequence.status}`}>
                            {option.consequence.text}
                        </em>
                    </button>
                );
            })}
        </div>
    );
}

function RelicActionBrief({ turn }: RelicTurnPanelProps) {
    const view = turn.viewModel;
    const coordination = view.snapshot
        ? derivePartyCoordination(view.snapshot, view.localPlayerId, turn.selection.draft.kind)
        : undefined;
    return (
        <div className="action-brief">
            <strong>{view.actionInfo.label}</strong>
            <span>{view.actionInfo.description}</span>
            {view.turnStatus.isLocked && <small>Your submitted plan stays locked for this round.</small>}
            {view.submitBlocker && !view.turnStatus.isLocked && <small>{view.submitBlocker}</small>}
            {coordination && <small>{coordination.actionHint}</small>}
            {view.actionBriefDanger && <small className="action-brief-danger">! {view.actionBriefDanger}</small>}
        </div>
    );
}

function RelicPlanTargets({ game, turn }: RelicRoundPlanProps) {
    const { draft, roomId } = turn.selection;
    const { moveTargets, stealTargets } = turn.viewModel;
    if (draft.kind === 'move' && game.snapshot) {
        return (
            <MoveTargetChoices
                snapshot={game.snapshot}
                moveTargets={moveTargets}
                selectedRoomId={draft.targetRoomId ?? roomId ?? moveTargets[0]}
                exitDistances={castleMapExitDistances(game.snapshot.map)}
                onSelect={turn.actions.selectMove}
            />
        );
    }
    if (draft.kind === 'steal') {
        return (
            <StealTargetChoices
                stealTargets={stealTargets}
                selectedPlayerId={draft.targetPlayerId ?? stealTargets[0]?.playerId}
                onSelect={turn.actions.selectSteal}
            />
        );
    }
    return null;
}

function RelicRoundWarnings({ turn }: RelicTurnPanelProps) {
    const noise = turn.viewModel.roundNoiseCount;
    const warning = turn.viewModel.roundLimitWarning;
    return (
        <>
            {noise > 0 && (
                <div className={`noise-meter ${noise >= 3 ? 'noise-high' : noise >= 2 ? 'noise-medium' : 'noise-low'}`}>
                    <span>Last round noise</span>
                    <span className="noise-pips">
                        {Array.from(
                            { length: Math.min(5, noise) },
                            (_, index) => <span key={index} className="noise-pip" />
                        )}
                    </span>
                    <small>{noise >= 3 ? 'Rooms destabilising' : 'Some disruption'}</small>
                </div>
            )}
            {warning && (
                <div className={`round-warning ${warning.severity === 'danger' ? 'round-warning-final' : ''}`}>
                    {warning.message}
                </div>
            )}
        </>
    );
}

function RelicPlanSubmission({ game, turn, lang }: RelicRoundPlanProps) {
    const status = turn.viewModel.turnStatus;
    const timedOut = status.waitingPlayerCount > 0 && turn.timeRemainingMs !== null && turn.timeRemainingMs <= 0;
    const resolve = async () => {
        playUiSound('start');
        await game.forceResolveRound();
    };
    return (
        <>
            <button
                type="button"
                className="primary action-submit-button"
                disabled={!status.canSubmit}
                onClick={() => void turn.actions.submit()}
            >
                {status.isLocked ? UI[lang].boundButton : (
                    <>
                        {UI[lang].submitButton} <kbd className="action-key action-key-enter">↵</kbd>
                    </>
                )}
            </button>
            {timedOut && (
                <div className="force-resolve-panel">
                    <small>{status.waitingPlayerCount} timed-out {plural('hunter', status.waitingPlayerCount)}.</small>
                    <button
                        type="button"
                        className="secondary action-force-resolve-button"
                        onClick={() => void resolve()}
                    >
                        Resolve Timed-Out Round
                    </button>
                </div>
            )}
        </>
    );
}

export function RelicReviewPanel({ game, turn }: RelicRoundPlanProps) {
    if (!turn.reviewing || !game.snapshot) {
        return null;
    }
    return (
        <section className="action-command-panel review-command-panel" aria-label="Round review">
            <span className="panel-label">Round {game.snapshot.round} Review</span>
            <div className="action-brief">
                <strong>Watch the revealed plans</strong>
                <span>The neon facility is replaying every plan in the scene.</span>
                <small>
                    {turn.viewModel.isAdmin
                        ? 'Playback advances automatically, or the director can skip.'
                        : 'The director will advance after everyone has seen enough.'}
                </small>
            </div>
            {turn.viewModel.isAdmin && (
                <button
                    type="button"
                    className="primary action-submit-button"
                    onClick={() => void turn.actions.continueReview()}
                >
                    {willReviewEndGame(game.snapshot) ? 'Skip to finale' : 'Skip review'}
                </button>
            )}
        </section>
    );
}

interface RoundTimerProps {
    readonly timeRemainingMs: number;
    readonly lang: Lang;
}

function RoundTimer({
    timeRemainingMs,
    lang
}: RoundTimerProps) {
    const totalSecs = Math.max(0, Math.ceil(timeRemainingMs / 1000));
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    const display = `${mins}:${String(secs).padStart(2, '0')}`;
    const isUrgent = totalSecs <= 10;
    return (
        <div className={`round-timer${isUrgent ? ' round-timer-urgent' : ''}`}>
            <span>{UI[lang].timerLabel}</span>
            <strong>{display}</strong>
        </div>
    );
}

interface TurnPlanStatusCardProps {
    readonly snapshot: RelicPublicSnapshot;
    readonly localPlayerId?: string;
}

function TurnPlanStatusCard({
    snapshot,
    localPlayerId
}: TurnPlanStatusCardProps) {
    const activePlayers = snapshot.players.filter((player) => !player.escaped && !player.defeated);
    const submittedPlayers = activePlayers.filter((player) => snapshot.submittedPlayerIds.includes(player.playerId));
    const waitingPlayers = activePlayers.filter((player) => !snapshot.submittedPlayerIds.includes(player.playerId));
    const localSubmitted = !!localPlayerId &&
        snapshot.submittedPlayerIds.includes(localPlayerId);
    const waitingCount = waitingPlayers.length;
    const title = localSubmitted
        ? 'Plan locked'
        : waitingCount === 1 && waitingPlayers[0]?.playerId === localPlayerId
        ? 'Waiting on your plan'
        : 'Choose this round';
    const detail = localSubmitted
        ? waitingCount > 0
            ? `${waitingCount} ${plural('hunter', waitingCount)} still choosing.`
            : 'All plans locked.'
        : `${submittedPlayers.length}/${activePlayers.length} plans locked.`;

    return (
        <div className={`turn-plan-status${localSubmitted ? ' locked' : ''}`} aria-live="polite">
            <div>
                <span className="panel-label">Round {snapshot.round}</span>
                <strong>{title}</strong>
                <small>{detail}</small>
            </div>
            <div className="turn-plan-counters" aria-label="Planning progress">
                <span>{submittedPlayers.length} locked</span>
                <span>{waitingCount} waiting</span>
            </div>
        </div>
    );
}

interface MoveTargetChoicesProps {
    readonly snapshot: RelicPublicSnapshot;
    readonly moveTargets: readonly string[];
    readonly selectedRoomId?: string;
    readonly exitDistances: Map<string, number>;
    onSelect(roomId: string): void;
}

function MoveTargetChoices({
    snapshot,
    moveTargets,
    selectedRoomId,
    exitDistances,
    onSelect
}: MoveTargetChoicesProps) {
    return (
        <div className="target-choice-section">
            <span className="panel-label">Move Target</span>
            {moveTargets.length === 0
                ? <div className="target-empty">No open adjacent paths.</div>
                : (
                    <div className="target-choice-grid">
                        {moveTargets.map((roomId) => {
                            const room = snapshot.map.find((candidate) => candidate.id === roomId);
                            const dist = exitDistances.get(roomId);
                            const hasRelic = snapshot.relics.some((relic) =>
                                relic.roomId === roomId &&
                                !relic.foundBy &&
                                !relic.carriedBy &&
                                !relic.escapedBy
                            );
                            const selected = selectedRoomId === roomId;
                            return (
                                <button
                                    type="button"
                                    key={roomId}
                                    className={`target-option${selected ? ' active' : ''}`}
                                    data-target-room-id={roomId}
                                    aria-pressed={selected}
                                    onClick={() => onSelect(roomId)}
                                >
                                    <span className="target-option-title">
                                        {room?.name ?? roomId}
                                    </span>
                                    <span className="target-option-meta">
                                        {room?.kind ?? 'room'}
                                        {dist !== undefined ? ` / ${dist} to exit` : ''}
                                        {hasRelic ? ' / relic signal' : ''}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
        </div>
    );
}

interface StealTargetChoicesProps {
    readonly stealTargets: readonly RelicPlayer[];
    readonly selectedPlayerId?: string;
    onSelect(playerId: string): void;
}

function StealTargetChoices({
    stealTargets,
    selectedPlayerId,
    onSelect
}: StealTargetChoicesProps) {
    return (
        <div className="target-choice-section">
            <span className="panel-label">Steal Target</span>
            {stealTargets.length === 0
                ? <div className="target-empty">No active hunter in this room carries a target.</div>
                : (
                    <div className="target-choice-grid">
                        {stealTargets.map((player) => {
                            const character = findRelicCharacter(player.characterId);
                            const selected = selectedPlayerId === player.playerId;
                            return (
                                <button
                                    type="button"
                                    key={player.playerId}
                                    className={`target-option${selected ? ' active' : ''}`}
                                    data-target-player-id={player.playerId}
                                    aria-pressed={selected}
                                    onClick={() => onSelect(player.playerId)}
                                >
                                    <span className="target-option-title">{player.username}</span>
                                    <span className="target-option-meta">
                                        {character.role} / {player.relicIds.length}{' '}
                                        {plural('relic', player.relicIds.length)} / {player.score} score
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
        </div>
    );
}

interface LockedPlanCardProps {
    readonly action?: RelicActionInput;
    readonly snapshot: RelicPublicSnapshot;
    readonly localPlayerId?: string;
}

function LockedPlanCard({
    action,
    snapshot,
    localPlayerId
}: LockedPlanCardProps) {
    const active = snapshot.players.filter((p) => !p.escaped && !p.defeated);
    const submitted = active.filter((p) => snapshot.submittedPlayerIds.includes(p.playerId));
    const waiting = active.filter((p) => !snapshot.submittedPlayerIds.includes(p.playerId));

    return (
        <div className="locked-plan-card">
            <span className="panel-label">Plan Locked</span>
            <strong className="locked-action-label">
                {action ? toRelicActionLabel(action, snapshot) : 'Plan submitted'}
            </strong>
            <div className="locked-waiting-list">
                {submitted.map((p) => (
                    <span
                        key={p.playerId}
                        className={`locked-player locked-player-done${p.playerId === localPlayerId ? ' local' : ''}`}
                    >
                        {p.username}
                    </span>
                ))}
                {waiting.map((p) => (
                    <span key={p.playerId} className="locked-player locked-player-waiting">
                        {p.username}
                    </span>
                ))}
            </div>
            {waiting.length > 0
                ? <small>{waiting.length} {plural('hunter', waiting.length)} still choosing…</small>
                : <small>All plans locked. The castle is about to answer.</small>}
        </div>
    );
}

function toRelicActionLabel(action: RelicActionInput, snapshot: RelicPublicSnapshot): string {
    switch (action.kind) {
        case 'move': {
            const target = snapshot.map.find((r) => r.id === action.targetRoomId);
            return `Move → ${target?.name ?? action.targetRoomId}`;
        }
        case 'search':
            return 'Search this room';
        case 'steal': {
            const target = snapshot.players.find((p) => p.playerId === action.targetPlayerId);
            return `Steal from ${target?.username ?? '—'}`;
        }
        case 'escape':
            return 'Escape the ruin';
    }
}

interface RoomActionNudgeProps {
    readonly room: RelicPublicSnapshot['map'][number];
    readonly lang: Lang;
}

export function RoomActionNudge({
    room,
    lang
}: RoomActionNudgeProps) {
    const hints: Record<string, string> = lang === 'no'
        ? {
            monster: '⚔️ Monsterrom — Søk for å bekjempe, eller flytt deg',
            trap: '⚠️ Fellrom — Søk med forsiktighet, eller flytt deg',
            treasure: '💎 Skattkammer — Søk etter en relikvie!',
            shrine: '🌀 Helligdom — Søk for mystiske gaver',
            entrance: '🏯 Inngang — Velg en rute inn i slottet',
            exit: '🚪 Utgang — Bruk Unnslippe-handlingen hvis du har relikvier!',
            hallway: '🔦 Korridor — Fortsett inn i slottet'
        }
        : {
            monster: '⚔️ Monster room — Search to fight, or move away',
            trap: '⚠️ Trap room — Search carefully, or move away',
            treasure: '💎 Treasure room — Search for a relic!',
            shrine: '🌀 Shrine room — Search for mysterious gifts',
            entrance: '🏯 Entrance — Choose a route into the castle',
            exit: '🚪 Exit — Use Escape action if you carry relics!',
            hallway: '🔦 Corridor — Press onward into the castle'
        };
    const hint = hints[room.kind] ?? (lang === 'no' ? 'Velg en handling' : 'Choose an action');
    return <span>{hint}</span>;
}

function willReviewEndGame(snapshot: RelicPublicSnapshot): boolean {
    const active = snapshot.players.some((player) => !player.escaped && !player.defeated);
    return snapshot.round + 1 > snapshot.maxRounds || !active;
}
