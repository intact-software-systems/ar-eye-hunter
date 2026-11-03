/// <reference types="vite/types/importMeta.d.ts" />

import { useEffect, useState } from 'react';

import { GameHudLayout } from './game/hud/GameHudLayout.tsx';
import { RelicFloatingHud, RelicOverlays } from './game/hud/relic-overlays.tsx';
import { summarizeRelicHuntersRuntime } from './game/hud/relic-runtime-diagnostics.tsx';
import { RelicSidePanel } from './game/hud/relic-side-panel.tsx';
import { RelicStatus } from './game/hud/relic-status.tsx';
import { RelicTimeline } from './game/hud/relic-timeline.tsx';
import { phaseLabel } from './game/lang.ts';
import { OpeningRelicScene } from './game/OpeningRelicScene.tsx';
import type { RelicHuntersRuntime } from './game/relic-hunters-runtime.ts';
import { RelicSceneNext } from './game/RelicSceneNext.tsx';
import { playUiSound } from './game/sound.ts';
import { useRelicHunters } from './game/use-relic-hunters.ts';
import { useRelicPlayback, type RelicPlayback } from './game/use-relic-playback.ts';
import { useRelicPreferences } from './game/use-relic-preferences.ts';
import { useRelicTurn, type RelicTurn } from './game/use-relic-turn.ts';

export default function App() {
    const game = useRelicHunters();
    const preferences = useRelicPreferences(!!game.session);
    const playback = useRelicPlayback(game, preferences.lang);
    const turn = useRelicTurn(game, preferences, playback.events);
    useRelicRuntimeDiagnostics(game);
    return (
        <GameHudLayout
            scene={<RelicGameScene game={game} turn={turn} playback={playback} />}
            top={
                <RelicStatus
                    phaseText={phaseLabel(game.snapshot?.phase ?? game.connectionState, preferences.lang)}
                    snapshot={game.snapshot}
                    onToggleHelp={() => preferences.setHelpVisible(!preferences.helpVisible)}
                />
            }
            side={<RelicSidePanel game={game} turn={turn} preferences={preferences} playback={playback} />}
            bottom={
                <RelicTimeline
                    snapshot={game.snapshot}
                    localPlayerId={game.participation === 'player' ? game.session?.sessionId : undefined}
                    revealedEvents={playback.events}
                    lastEvent={playback.lastEvent}
                    lang={preferences.lang}
                />
            }
            floating={<RelicFloatingHud game={game} turn={turn} preferences={preferences} playback={playback} />}
            overlays={<RelicOverlays game={game} turn={turn} preferences={preferences} playback={playback} />}
        />
    );
}

interface RelicGameSceneProps {
    readonly game: RelicHuntersRuntime.Connection;
    readonly turn: RelicTurn;
    readonly playback: RelicPlayback;
}

function RelicGameScene({ game, turn, playback }: RelicGameSceneProps) {
    const [entry, setEntry] = useState(() => game.roomEntry.getState());
    useEffect(() => game.roomEntry.onChange(setEntry), [game.roomEntry]);
    if (!game.snapshot) {
        // Entry can finish before the runtime adopts its room and hydrates the expedition.
        const preparingExpedition = game.connectionState === 'connecting' ||
            game.connectionState === 'joining-room' ||
            (game.connectionState === 'connected' && (game.roomId !== undefined || entry.status === 'entered')) ||
            (game.session !== undefined && (entry.status === 'pending' || entry.status === 'joining'));
        return <RelicOpeningPresentation preparingExpedition={preparingExpedition} />;
    }
    const pickup = async (relicId: string) => {
        playUiSound('select');
        await game.pickupRelic(relicId);
    };
    return (
        <RelicSceneNext
            snapshot={game.snapshot}
            localPlayerId={game.participation === 'player' ? game.session?.sessionId : undefined}
            selectedRoomId={turn.selection.roomId}
            primedAction={turn.selection.primedAction}
            focusRoomId={playback.focusRoomId}
            rtcReady={game.diagnostics.rtcReady}
            inputEnabled={game.participation === 'player' &&
                (game.snapshot.phase === 'planning' || game.snapshot.phase === 'finished')}
            reviewDirector={turn.viewModel.isAdmin}
            onSelectRoom={turn.selection.setRoomId}
            onPrimeAction={turn.selection.prime}
            onPickupRelic={pickup}
            onReviewPlaybackComplete={turn.actions.continueReview}
        />
    );
}

interface RelicOpeningPresentationProps {
    readonly preparingExpedition: boolean;
}

function RelicOpeningPresentation({ preparingExpedition }: RelicOpeningPresentationProps) {
    // Keep an existing opening scene through sign-in; only defer a new graphics context.
    const [started, setStarted] = useState(!preparingExpedition);
    useEffect(() => {
        if (!preparingExpedition) {
            setStarted(true);
        }
    }, [preparingExpedition]);
    return started ? <OpeningRelicScene /> : null;
}

function useRelicRuntimeDiagnostics(game: RelicHuntersRuntime.Connection): void {
    useEffect(() => {
        if (import.meta.env.DEV) {
            Object.defineProperty(window, '__relicHuntersRuntime', {
                configurable: true,
                value: summarizeRelicHuntersRuntime(game.roomId, game.diagnostics, game.snapshot)
            });
        }
    }, [game.diagnostics, game.roomId, game.snapshot]);
}
