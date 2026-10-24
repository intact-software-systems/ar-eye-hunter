import { useEffect, useState } from 'react';

import { RelicAiCompanionPanel } from '../ai/relic-ai-panel.tsx';
import { useRelicPlanningAi } from '../ai/useRelicPlanningAi.ts';
import type { RelicHuntersRuntime } from '../relic-hunters-runtime.ts';
import { playUiSound } from '../sound.ts';
import type { RelicPlayback } from '../use-relic-playback.ts';
import type { RelicPreferences } from '../use-relic-preferences.ts';
import type { RelicTurn } from '../use-relic-turn.ts';
import {
    ClueJournal,
    RoomDetailCard,
    RoomIntel
} from './relic-intel.tsx';
import {
    RelicLobby,
    RelicPreferencesControls,
    SidePanelMenu
} from './relic-lobby.tsx';
import { CastleMap, castleMapExitDistances } from './relic-map.tsx';
import {
    computePartyCoordination,
    PartyChangePrompt,
    PartyCoordinationPanel,
    RelicPartyControls
} from './relic-party.tsx';
import { RelicReviewPanel, RelicRoundPlan } from './relic-plan.tsx';
import { RelicRoomEntry } from './relic-room-entry.tsx';
import { RallarDiagnosticsPanel } from './relic-runtime-diagnostics.tsx';
import { EscapeDecisionPanel } from './relic-score.tsx';

interface RelicSidePanelProps {
    readonly game: RelicHuntersRuntime.Connection;
    readonly turn: RelicTurn;
    readonly preferences: RelicPreferences;
    readonly playback: RelicPlayback;
}

export function RelicSidePanel({ game, turn, preferences, playback }: RelicSidePanelProps) {
    const [collapsed, setCollapsed] = useState(false);
    const [dismissedPartyChange, setDismissedPartyChange] = useState<string | undefined>();
    useEffect(() => setDismissedPartyChange(undefined), [game.snapshot?.gameId]);
    const reset = async () => {
        playUiSound('reset');
        setDismissedPartyChange(undefined);
        await game.resetExpedition();
    };
    return (
        <section className={`side-panel${collapsed ? ' collapsed' : ''}`}>
            <button
                type="button"
                className="side-panel-toggle"
                onClick={() => setCollapsed(!collapsed)}
                title={collapsed ? 'Expand panel' : 'Collapse panel'}
            >
                {collapsed ? '▶ Panel' : '◀ Collapse'}
            </button>
            {game.session && <RelicSectionMenu game={game} />}
            <RelicRoomEntry game={game} />
            <RelicLobby game={game} preferences={preferences} />
            {game.session && game.roomId && (
                <>
                    <RelicExpeditionPanel game={game} turn={turn} preferences={preferences} reset={reset} />
                    <RelicExplorationPanels game={game} turn={turn} playback={playback} preferences={preferences} />
                    <RelicPartyChange
                        game={game}
                        dismissed={dismissedPartyChange}
                        dismiss={setDismissedPartyChange}
                        reset={reset}
                    />
                </>
            )}
            {import.meta.env.DEV && game.session && <RallarDiagnosticsPanel diagnostics={game.diagnostics} />}
            {game.error && <div className="panel error-panel">{game.error}</div>}
        </section>
    );
}

interface RelicSectionMenuProps {
    readonly game: RelicHuntersRuntime.Connection;
}

function RelicSectionMenu({ game }: RelicSectionMenuProps) {
    const items = [{ id: 'hud-rooms', label: 'Rooms' }];
    if (game.roomId) {
        items.push({ id: 'hud-plan', label: game.snapshot?.phase === 'planning' ? 'Plan' : 'Party' });
    }
    if (game.roomId && game.snapshot) {
        items.push({ id: 'hud-ai', label: 'AI' }, { id: 'hud-map', label: 'Map' }, { id: 'hud-intel', label: 'Intel' });
    }
    return (
        <SidePanelMenu
            items={items}
            onJump={(id) => document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'auto' })}
        />
    );
}

interface RelicExpeditionPanelProps {
    readonly game: RelicHuntersRuntime.Connection;
    readonly turn: RelicTurn;
    readonly preferences: RelicPreferences;
    readonly reset: () => Promise<void>;
}

function RelicExpeditionPanel({ game, turn, preferences, reset }: RelicExpeditionPanelProps) {
    const planningAi = useRelicPlanningAi({
        snapshot: game.snapshot,
        localPlayerId: game.session?.sessionId,
        localPrincipalId: game.session?.clientId,
        draft: turn.selection.draft,
        lang: preferences.lang,
        viewModel: turn.viewModel,
        sceneObjective: turn.sceneObjective
    });
    return (
        <div id="hud-plan" className="panel stack">
            <RelicPartyControls game={game} turn={turn} preferences={preferences} />
            <div className="button-grid">
                <button type="button" onClick={() => void reset()}>
                    {preferences.lang === 'no' ? 'Tilbakestill' : 'Reset'}
                </button>
                <RelicPreferencesControls preferences={preferences} />
            </div>
            <RelicRoundPlan game={game} turn={turn} lang={preferences.lang} />
            {game.snapshot && game.session && turn.planning && (
                <RelicAiCompanionPanel
                    state={planningAi}
                    snapshot={game.snapshot}
                    localPlayerId={game.session.sessionId}
                    onAsk={planningAi.ask}
                    onPrime={turn.selection.prime}
                />
            )}
            <RelicReviewPanel game={game} turn={turn} lang={preferences.lang} />
        </div>
    );
}

function RelicExplorationPanels({ game, turn, playback }: RelicSidePanelProps) {
    const snapshot = game.snapshot;
    const session = game.session;
    if (!snapshot || !session) {
        return (
            <RoomIntel
                currentRoom={turn.viewModel.currentRoom}
                moveTargets={turn.viewModel.moveTargets}
                snapshot={snapshot}
            />
        );
    }
    const coordination = computePartyCoordination(snapshot, session.sessionId, turn.selection.draft.kind);
    return (
        <>
            <EscapeDecisionPanel snapshot={snapshot} localPlayerId={session.sessionId} />
            {coordination && (
                <PartyCoordinationPanel snapshot={snapshot} localPlayerId={session.sessionId} summary={coordination} />
            )}
            <CastleMap
                snapshot={snapshot}
                localPlayerId={session.sessionId}
                selectedRoomId={turn.selection.roomId}
                lastEvent={playback.lastEvent}
                onSelectRoom={turn.selection.setRoomId}
            />
            {turn.selection.roomId && (
                <RoomDetailCard
                    snapshot={snapshot}
                    roomId={turn.selection.roomId}
                    localPlayerId={session.sessionId}
                    exitDistances={castleMapExitDistances(snapshot.map)}
                    onPrimeMove={turn.actions.selectMove}
                    onDismiss={() => turn.selection.setRoomId(undefined)}
                />
            )}
            <ClueJournal snapshot={snapshot} onSelectRoom={turn.selection.setRoomId} />
            <RoomIntel
                currentRoom={turn.viewModel.currentRoom}
                moveTargets={turn.viewModel.moveTargets}
                snapshot={snapshot}
            />
        </>
    );
}

interface RelicPartyChangeProps {
    readonly game: RelicHuntersRuntime.Connection;
    readonly dismissed: string | undefined;
    readonly dismiss: (key: string) => void;
    readonly reset: () => Promise<void>;
}

function RelicPartyChange({ game, dismissed, dismiss, reset }: RelicPartyChangeProps) {
    const snapshot = game.snapshot;
    const summary = game.rooms.find((room) => room.roomId === game.roomId);
    if (
        !snapshot || !summary || snapshot.phase === 'finished' || snapshot.players.length === 0 ||
        snapshot.players.length === summary.onlineMemberCount
    ) {
        return null;
    }
    const key = `${game.roomId}:${snapshot.players.length}:${summary.onlineMemberCount}`;
    return key === dismissed
        ? null
        : (
            <PartyChangePrompt
                expeditionPlayers={snapshot.players.length}
                onlinePlayers={summary.onlineMemberCount}
                onReset={reset}
                onContinue={() => dismiss(key)}
            />
        );
}
