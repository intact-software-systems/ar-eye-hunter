import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BabylonArena } from '../../../apps/ar-eye-hunter-v1/src/game/babylon-arena.tsx';
import type { BabylonArenaProps } from '../../../apps/ar-eye-hunter-v1/src/game/scene/arena-scene-contracts.ts';
import { createInitialArenaState, toArenaSnapshot } from '../../../apps/ar-eye-hunter-v1/src/game/simulation.ts';
import type { ArenaSnapshot } from '../../../apps/ar-eye-hunter-v1/src/game/types.ts';

const nowEpochMs = Date.now();
const initial = createInitialArenaState(44, nowEpochMs);
const initialSnapshot: ArenaSnapshot = {
    ...toArenaSnapshot(initial, 'shot-arena', nowEpochMs),
    targets: [{ ...initial.targets[0], position: [-45, 1.72, -43], velocity: [0, 0, 0], health: 10 }]
};

function ShotRegressionScene() {
    const [snapshot, setSnapshot] = useState(initialSnapshot);
    const [published, setPublished] = useState<ArenaSnapshot>();
    const [hit, setHit] = useState(false);
    const props: BabylonArenaProps = {
        localSessionId: 'host',
        localUsername: 'alice',
        localColor: '#00ff88',
        roomId: 'shot-arena',
        roomReady: true,
        networkEnabled: true,
        authority: {
            roomId: 'shot-arena',
            sessionId: 'host',
            epoch: 1,
            local: true,
            fresh: true,
            freshUntilEpochMs: nowEpochMs + 120_000
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
        onLocalShot: (_shot, accepted) => setHit(accepted.hit),
        onArenaSnapshot: (next) => {
            setPublished(next);
            setSnapshot(next);
        }
    };
    return (
        <>
            <button onClick={() => setSnapshot(startFixtureMatch)}>Accept match snapshot</button>
            <output data-testid="accepted-match">{snapshot.match?.matchId ?? 'none'}</output>
            <output data-testid="published-match">{published?.match?.matchId ?? 'none'}</output>
            <output data-testid="shot-hit">{String(hit)}</output>
            <BabylonArena {...props} />
        </>
    );
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
createRoot(root).render(<ShotRegressionScene />);
