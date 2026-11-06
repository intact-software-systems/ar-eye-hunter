import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { EngineStore } from '@babylonjs/core/Engines/engineStore.js';
import type { Effect } from '@babylonjs/core/Materials/effect.js';
import type { Scene } from '@babylonjs/core/scene.js';
import {
    StrictMode,
    useRef,
    useState
} from 'react';
import { createRoot } from 'react-dom/client';

import type { ArenaSnapshot } from '@ar-eye-hunter/arena-contracts.ts';
import { finishArenaMatchIfDue } from '@ar-eye-hunter/arena-match.ts';
import type { ArenaTournamentSnapshot } from '@ar-eye-hunter/arena-tournament-snapshot.ts';
import { createInitialArenaState, toArenaSnapshot } from '@ar-eye-hunter/simulation.ts';
import { AR_EYE_TOURNAMENT_RULES_ID, createTournamentArena } from '@ar-eye-hunter/tournament-arena.ts';
import { BabylonArena } from '../../../apps/ar-eye-hunter-v1/src/game/babylon-arena.tsx';
import type { BabylonArenaProps } from '../../../apps/ar-eye-hunter-v1/src/game/scene/arena-scene-contracts.ts';

interface FixtureSceneInput {
    readonly snapshot: ArenaSnapshot;
    readonly sessionId: string | undefined;
    readonly onShot: BabylonArenaProps['onLocalShot'];
    readonly onSnapshot: BabylonArenaProps['onArenaSnapshot'];
}
interface InitialRenderer {
    readonly engine: AbstractEngine;
    readonly scene: Scene;
    readonly floorEffect: Effect;
}

function ShotRegressionScene() {
    const [snapshot, setSnapshot] = useState(() => createFixtureSnapshot('shot-arena'));
    const [published, setPublished] = useState<ArenaSnapshot>();
    const [hit, setHit] = useState(false);
    const [shotDirection, setShotDirection] = useState<readonly number[]>([]);
    const [sessionId, setSessionId] = useState<string | undefined>('host');
    const props = createFixtureSceneProps({
        snapshot,
        sessionId,
        onShot: (shot, accepted) => {
            setHit(accepted.hit);
            setShotDirection(shot.direction);
        },
        onSnapshot: (next) => {
            setPublished(next);
            setSnapshot(next);
            return true;
        }
    });
    return (
        <>
            <button onClick={() => setSnapshot(startFixtureMatch)}>Accept match snapshot</button>
            <button
                onClick={() => {
                    setSnapshot(createFixtureSnapshot('replacement-arena'));
                    setPublished(undefined);
                    setHit(false);
                }}
            >
                Change room
            </button>
            <button onClick={() => setSessionId('replacement-player')}>Change player</button>
            <button
                onClick={() => {
                    setSnapshot(createFixtureSnapshot('shot-arena'));
                    setSessionId(undefined);
                }}
            >
                Play without session
            </button>
            <output data-testid="accepted-match">{snapshot.match?.matchId ?? 'none'}</output>
            <output data-testid="published-match">{published?.match?.matchId ?? 'none'}</output>
            <output data-testid="published-room">{published?.roomId ?? 'none'}</output>
            <output data-testid="shot-hit">{String(hit)}</output>
            <output data-testid="shot-direction">{JSON.stringify(shotDirection)}</output>
            <NativeTournamentScene {...props} />
        </>
    );
}

function NativeTournamentScene(props: BabylonArenaProps) {
    const [mounted, setMounted] = useState(true);
    const [tournament, setTournament] = useState<ArenaTournamentSnapshot>();
    const [spectating, setSpectating] = useState(false);
    const [nativeControls, setNativeControls] = useState('');
    const [preview, setPreview] = useState(false);
    return (
        <div data-preview-controls={preview ? 'true' : 'false'}>
            <button onClick={() => setPreview(true)}>Open untouched preview</button>
            <button onClick={() => setPreview(false)}>Join fixture room</button>
            <input aria-label="Ops note" />
            <button onClick={() => setMounted(false)}>Unmount arena</button>
            <button onClick={() => setMounted(true)}>Mount arena</button>
            <button onClick={() => setTournament(createFixtureTournament('native-match-1'))}>Enter native match</button>
            <button onClick={() => setTournament(createFixtureTournament('native-match-2'))}>Enter next native match</button>
            <button onClick={() => setTournament(undefined)}>Return to casual play</button>
            <button onClick={() => setSpectating((current) => !current)}>Toggle spectator</button>
            <button onClick={() => setTournament(finishFixtureTournament)}>Finish native match</button>
            <button onClick={() => setTournament((current) => current && { ...current, status: 'cancelled', state: null })}>
                Cancel native match without state
            </button>
            <button onClick={() => setTournament((current) => current && { ...current, status: 'scheduled', state: null })}>
                Schedule native match
            </button>
            <button onClick={() => setTournament((current) => current && { ...structuredClone(current), observedAtEpochMs: Date.now() })}>
                Poll unchanged native match
            </button>
            <button onClick={() => setTournament(reviseFixtureTournament)}>Update terminal revision</button>
            <button
                onClick={() => {
                    const next = finishFixtureTournament(createFixtureTournament('another-terminal-match'));
                    setTournament(next);
                }}
            >
                Show another terminal game
            </button>
            <RendererInspection />
            <output data-testid="native-controls">{nativeControls}</output>
            {mounted && (
                <BabylonArena
                    {...toPreviewSceneProps(props, preview)}
                    spectating={spectating}
                    tournament={tournament && {
                        snapshot: tournament,
                        sendControls: (controls) => setNativeControls(JSON.stringify(controls))
                    }}
                />
            )}
        </div>
    );
}

function toPreviewSceneProps(props: BabylonArenaProps, preview: boolean): BabylonArenaProps {
    return preview
        ? {
            ...props,
            roomId: undefined,
            roomReady: true,
            networkEnabled: false,
            arenaSnapshot: undefined,
            authority: { roomId: undefined, sessionId: undefined, epoch: undefined, local: false, fresh: false, freshUntilEpochMs: 0 }
        }
        : props;
}

function RendererInspection() {
    const initial = useRef<InitialRenderer | undefined>(undefined);
    const [inspection, setInspection] = useState('');
    const [frameInspection, setFrameInspection] = useState('');
    return (
        <>
            <button onClick={resizeFixtureArena}>Resize arena</button>
            {[1, 2].map((scale) => (
                <button key={scale} onClick={() => EngineStore.Instances[0].setHardwareScalingLevel(scale)}>
                    Render scale {scale}
                </button>
            ))}
            <button
                onClick={() => {
                    const engine = EngineStore.Instances[0];
                    const scene = engine?.scenes[0];
                    const floorEffect = scene?.getMeshByName('floor')?.subMeshes?.[0]?.effect;
                    if (!initial.current && engine && scene && floorEffect) {
                        initial.current = { engine, scene, floorEffect };
                    }
                    setFrameInspection(JSON.stringify({
                        frame: scene?.getFrameId() ?? 0,
                        width: engine?.getRenderWidth() ?? 0,
                        height: engine?.getRenderHeight() ?? 0,
                        loops: engine?.activeRenderLoops.length ?? 0,
                        ready: scene?.isReady() ?? false
                    }));
                    setInspection(JSON.stringify({
                        sameEngine: engine !== undefined && engine === initial.current?.engine,
                        originalEngineDisposed: initial.current?.engine.isDisposed,
                        originalSceneDisposed: initial.current?.scene.isDisposed,
                        originalFloorEffectDisposed: initial.current?.floorEffect.isDisposed,
                        sameFloorEffect: floorEffect !== undefined && floorEffect === initial.current?.floorEffect,
                        multisampling: engine?.getRenderingCanvas()?.getContext('webgl2')?.getContextAttributes()?.antialias ?? false,
                        effectLayers: scene?.effectLayers?.length ?? 0,
                        scenes: engine?.scenes.length ?? 0,
                        loops: engine?.activeRenderLoops.length ?? 0
                    }));
                }}
            >
                Inspect renderer
            </button>
            <output data-testid="renderer-inspection">{inspection}</output>
            <output data-testid="renderer-frame-inspection">{frameInspection}</output>
        </>
    );
}

function resizeFixtureArena(): void {
    const canvas = document.querySelector('canvas');
    if (!canvas) {
        throw new Error('The fixture requires a mounted arena canvas.');
    }
    canvas.style.width = '720px';
    canvas.style.height = '400px';
    window.dispatchEvent(new Event('resize'));
}

function createFixtureSnapshot(roomId: string): ArenaSnapshot {
    const now = Date.now();
    const initial = createInitialArenaState(44, now);
    return {
        ...toArenaSnapshot(initial, roomId, now),
        targets: [{ ...initial.targets[0], position: [-45, 1.72, -43], velocity: [0, 0, 0], health: 10 }]
    };
}

function createFixtureSceneProps({ snapshot, sessionId, onShot, onSnapshot }: FixtureSceneInput): BabylonArenaProps {
    return {
        localSessionId: sessionId,
        localUsername: sessionId ?? 'local',
        localColor: '#00ff88',
        roomId: snapshot.roomId,
        roomReady: true,
        networkEnabled: sessionId !== undefined,
        spectating: false,
        authority: {
            roomId: snapshot.roomId,
            sessionId,
            epoch: 1,
            local: true,
            fresh: true,
            freshUntilEpochMs: snapshot.sentAtEpochMs + 120_000
        },
        linkState: { tone: 'live', label: 'Live arena', detail: 'Component fixture', playerCount: 1, actionNeeded: false },
        presenceNotices: [],
        remotePlayers: new Map(),
        remoteShots: [],
        remotePlayerHits: [],
        remoteEvents: [],
        arenaSnapshot: snapshot,
        onLocalPose: () => {},
        onPlayerHitIntent: () => {},
        onPickupIntent: () => {},
        onLocalCombatChange: () => {},
        onLocalPlayerChange: () => {},
        onLocalShot: onShot,
        onArenaSnapshot: onSnapshot
    };
}

function startFixtureMatch(previous: ArenaSnapshot): ArenaSnapshot {
    const now = Date.now();
    return {
        ...previous,
        revision: previous.revision + 1,
        match: {
            matchId: 'accepted-match',
            enrollment: 'open',
            status: 'active',
            durationMs: 60_000,
            directorSessionId: 'host',
            startedAtEpochMs: now,
            endsAtEpochMs: now + 60_000,
            baseline: {}
        }
    };
}

function createFixtureTournament(gameId: string): ArenaTournamentSnapshot {
    const now = Date.now();
    return {
        binding: {
            tournamentRef: { applicationId: 'arena-app', workspaceId: 'arena-workspace', tournamentId: 'fixture-cup' },
            slot: 'semifinal-1',
            attemptId: gameId,
            roomRef: { applicationId: 'arena-app', workspaceId: 'arena-workspace', groupId: 'shot-arena' },
            gameId,
            rulesId: AR_EYE_TOURNAMENT_RULES_ID,
            principalIds: ['host', 'opponent']
        },
        status: 'playing',
        attemptRevision: 1,
        observedAtEpochMs: now,
        state: createTournamentArena({ gameId, principalIds: ['host', 'opponent'], seed: 44, startedAtEpochMs: now, durationMs: 60_000 })
    };
}

function finishFixtureTournament(current: ArenaTournamentSnapshot | undefined): ArenaTournamentSnapshot {
    if (!current?.state) {
        throw new Error('Finish requires an existing native game.');
    }
    return {
        ...current,
        status: 'finished',
        state: {
            ...current.state,
            simulatedAtEpochMs: current.state.endsAtEpochMs,
            arena: { ...finishArenaMatchIfDue(current.state.arena, current.state.endsAtEpochMs), revision: 40 }
        }
    };
}

function reviseFixtureTournament(current: ArenaTournamentSnapshot | undefined): ArenaTournamentSnapshot {
    if (!current?.state) {
        throw new Error('Revision requires an existing terminal game.');
    }
    return { ...current, state: { ...current.state, arena: { ...current.state.arena, revision: 41 } } };
}

const root = document.getElementById('root');
if (!root) {
    throw new Error('The scene fixture requires its root element.');
}
createRoot(root).render(
    <StrictMode>
        <ShotRegressionScene />
    </StrictMode>
);
