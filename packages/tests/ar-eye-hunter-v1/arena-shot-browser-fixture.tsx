import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { EngineStore } from '@babylonjs/core/Engines/engineStore.js';
import type { Scene } from '@babylonjs/core/scene.js';
import {
    StrictMode,
    useRef,
    useState
} from 'react';
import { createRoot } from 'react-dom/client';

import type { ArenaSnapshot } from '../../../apps/ar-eye-hunter-v1/src/game/arena-contracts.ts';
import { BabylonArena } from '../../../apps/ar-eye-hunter-v1/src/game/babylon-arena.tsx';
import type { BabylonArenaProps } from '../../../apps/ar-eye-hunter-v1/src/game/scene/arena-scene-contracts.ts';
import { createInitialArenaState, toArenaSnapshot } from '../../../apps/ar-eye-hunter-v1/src/game/simulation.ts';

interface FixtureSceneInput {
    readonly snapshot: ArenaSnapshot;
    readonly sessionId: string | undefined;
    readonly onShot: BabylonArenaProps['onLocalShot'];
    readonly onSnapshot: BabylonArenaProps['onArenaSnapshot'];
}
interface InitialRenderer {
    readonly engine: AbstractEngine;
    readonly scene: Scene;
}

function ShotRegressionScene() {
    const [snapshot, setSnapshot] = useState(() => createFixtureSnapshot('shot-arena'));
    const [published, setPublished] = useState<ArenaSnapshot>();
    const [hit, setHit] = useState(false);
    const [sessionId, setSessionId] = useState<string | undefined>('host');
    const [mounted, setMounted] = useState(true);
    const props = createFixtureSceneProps({
        snapshot,
        sessionId,
        onShot: (_shot, accepted) => setHit(accepted.hit),
        onSnapshot: (next) => {
            setPublished(next);
            setSnapshot(next);
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
            <button onClick={() => setMounted(false)}>Unmount arena</button>
            <RendererInspection />
            <output data-testid="accepted-match">{snapshot.match?.matchId ?? 'none'}</output>
            <output data-testid="published-match">{published?.match?.matchId ?? 'none'}</output>
            <output data-testid="published-room">{published?.roomId ?? 'none'}</output>
            <output data-testid="shot-hit">{String(hit)}</output>
            {mounted && <BabylonArena {...props} />}
        </>
    );
}

function RendererInspection() {
    const initial = useRef<InitialRenderer | undefined>(undefined);
    const [inspection, setInspection] = useState('');
    return (
        <>
            <button
                onClick={() => {
                    const engine = EngineStore.Instances[0];
                    if (!initial.current && engine?.scenes[0]) {
                        initial.current = { engine, scene: engine.scenes[0] };
                    }
                    setInspection(JSON.stringify({
                        sameEngine: engine !== undefined && engine === initial.current?.engine,
                        originalEngineDisposed: initial.current?.engine.isDisposed,
                        originalSceneDisposed: initial.current?.scene.isDisposed,
                        scenes: engine?.scenes.length ?? 0,
                        loops: engine?.activeRenderLoops.length ?? 0
                    }));
                }}
            >
                Inspect renderer
            </button>
            <output data-testid="renderer-inspection">{inspection}</output>
        </>
    );
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
            status: 'active',
            durationMs: 60_000,
            directorSessionId: 'host',
            startedAtEpochMs: now,
            endsAtEpochMs: now + 60_000,
            baseline: {}
        }
    };
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
