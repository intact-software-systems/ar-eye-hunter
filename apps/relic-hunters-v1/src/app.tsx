/// <reference types="vite/types/importMeta.d.ts" />

import { useEffect } from 'react';

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
                    localPlayerId={game.session?.sessionId}
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
    if (!game.snapshot) {
        return <OpeningRelicScene />;
    }
    const pickup = async (relicId: string) => {
        playUiSound('select');
        await game.pickupRelic(relicId);
    };
    return (
        <RelicSceneNext
            snapshot={game.snapshot}
            localPlayerId={game.session?.sessionId}
            selectedRoomId={turn.selection.roomId}
            primedAction={turn.selection.primedAction}
            focusRoomId={playback.focusRoomId}
            rtcReady={game.diagnostics.rtcReady}
            inputEnabled={game.snapshot.phase === 'planning' || game.snapshot.phase === 'finished'}
            reviewDirector={turn.viewModel.isAdmin}
            onSelectRoom={turn.selection.setRoomId}
            onPrimeAction={turn.selection.prime}
            onPickupRelic={pickup}
            onReviewPlaybackComplete={turn.actions.continueReview}
        />
    );
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
