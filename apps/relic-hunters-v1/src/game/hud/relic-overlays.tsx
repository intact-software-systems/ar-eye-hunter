import type { RelicHuntersRuntime } from '../relic-hunters-runtime.ts';
import type { RelicPlayback } from '../use-relic-playback.ts';
import type { RelicPreferences } from '../use-relic-preferences.ts';
import type { RelicTurn } from '../use-relic-turn.ts';
import { SceneMinimapOverlay } from './relic-map.tsx';
import { RoomActionNudge } from './relic-plan.tsx';
import { RelicRematchControls } from './relic-rematch-controls.tsx';
import { VictoryPanel } from './relic-score.tsx';

interface RelicOverlaysProps {
    readonly game: RelicHuntersRuntime.Connection;
    readonly turn: RelicTurn;
    readonly preferences: RelicPreferences;
    readonly playback: RelicPlayback;
}

export function RelicFloatingHud({ game, turn, preferences, playback }: RelicOverlaysProps) {
    const view = turn.viewModel;
    const choosing = turn.planning && game.snapshot && game.session &&
        !game.snapshot.submittedPlayerIds.includes(game.session.sessionId);
    return (
        <>
            {playback.personalFlash && (
                <div
                    key={playback.personalFlash.key}
                    className={`personal-event-flash flash-${playback.personalFlash.tone}`}
                    onAnimationEnd={playback.clearPersonalFlash}
                    aria-hidden="true"
                />
            )}
            {view.lowHealthWarning && (
                <div className="low-health-banner" role="alert">{view.lowHealthWarning.message}</div>
            )}
            {turn.planning && <RelicKeyboardHints />}
            {choosing && (
                <div className="action-nudge" aria-live="polite">
                    {view.currentRoom
                        ? <RoomActionNudge room={view.currentRoom} lang={preferences.lang} />
                        : <span>Pick an action and submit</span>}
                </div>
            )}
            {game.snapshot && <SceneMinimapOverlay snapshot={game.snapshot} localPlayerId={game.session?.sessionId} />}
            <RelicPhaseAnnouncements playback={playback} />
        </>
    );
}

function RelicKeyboardHints() {
    return (
        <div className="controls-hud" aria-hidden="true">
            <span>
                <kbd>W</kbd>
                <kbd>A</kbd>
                <kbd>S</kbd>
                <kbd>D</kbd> Move
            </span>
            <span>
                <kbd>Q</kbd>
                <kbd>E</kbd> Turn
            </span>
            <span>
                <kbd>1</kbd>–<kbd>4</kbd> Pick action
            </span>
            <span>
                <kbd>←</kbd>
                <kbd>→</kbd> Target
            </span>
            <span>
                <kbd>↵</kbd> Submit
            </span>
        </div>
    );
}

interface RelicPhaseAnnouncementsProps {
    readonly playback: RelicPlayback;
}

function RelicPhaseAnnouncements({ playback }: RelicPhaseAnnouncementsProps) {
    return (
        <>
            {playback.phaseBanner && (
                <div
                    className={`phase-banner${playback.phaseBanner.start ? ' phase-banner-start' : ''}`}
                    role="status"
                    aria-live="assertive"
                    aria-atomic="true"
                >
                    {playback.phaseBanner.text}
                </div>
            )}
            {playback.roomFlash && (
                <div
                    key={playback.roomFlash.key}
                    className="room-entry-flash"
                    onAnimationEnd={playback.clearRoomFlash}
                    aria-live="polite"
                    aria-atomic="true"
                >
                    {playback.roomFlash.room}
                </div>
            )}
        </>
    );
}

export function RelicOverlays({ game, turn, preferences, playback }: RelicOverlaysProps) {
    const player = turn.viewModel.currentPlayer;
    const remaining = turn.timeRemainingMs;
    return (
        <>
            {preferences.helpVisible && <RelicHelpDialog close={() => preferences.setHelpVisible(false)} />}
            {player?.defeated && game.snapshot?.phase === 'planning' && (
                <div className="defeated-overlay" aria-live="polite">
                    <div className="defeated-card">
                        <span className="panel-label">Fallen</span>
                        <strong>You are down</strong>
                        <p>The castle keeps your relics. Watch the others — the expedition may still turn.</p>
                        <small>Your score: {player.score} pts</small>
                    </div>
                </div>
            )}
            {playback.tension && (
                <div className="tension-beat" aria-live="assertive" role="status">
                    <span>The castle answers…</span>
                </div>
            )}
            {game.snapshot?.phase === 'finished' && (
                <VictoryPanel snapshot={game.snapshot}>
                    <RelicRematchControls game={game} />
                </VictoryPanel>
            )}
            {remaining !== null && remaining > 0 && remaining <= 10_000 && turn.planning &&
                !turn.viewModel.turnStatus.isLocked && (
                <div className="round-countdown-overlay" role="status" aria-live="assertive">
                    <span className="round-countdown-number">{Math.ceil(remaining / 1000)}</span>
                    <span className="round-countdown-label">s</span>
                </div>
            )}
        </>
    );
}

interface RelicHelpDialogProps {
    readonly close: () => void;
}

function RelicHelpDialog({ close }: RelicHelpDialogProps) {
    return (
        <div className="help-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={close}>
            <div
                className="help-card"
                onClick={(event) =>
                    event.stopPropagation()}
            >
                <span className="panel-label">Controls</span>
                <div className="help-grid">
                    <kbd>WASD</kbd>
                    <span>Move in 3D scene</span>
                    <kbd>Mouse</kbd>
                    <span>Look around</span>
                    <kbd>1 – 4</kbd>
                    <span>Select action (Move/Search/Steal/Escape)</span>
                    <kbd>↵</kbd>
                    <span>Submit plan</span>
                    <kbd>? / F1</kbd>
                    <span>Toggle this help</span>
                    <kbd>Esc</kbd>
                    <span>Close overlays</span>
                </div>
                <button type="button" className="primary" onClick={close}>Close</button>
            </div>
        </div>
    );
}
