import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';
import { BabylonArena } from '../game/BabylonArena.tsx';
import { colorForId } from '../game/color.ts';
import {
    createInitialCombatState,
    createInitialLoadoutState,
    createInitialVitalsState,
    getWeaponStats
} from '../game/simulation.ts';
import type { ArenaMatchState, PlayerCombatState, PlayerLoadoutState, PlayerVitalsState } from '../game/types.ts';
import { SquadLinkChip } from './squad-link-chip.tsx';
import { toDirectorLabel, toMatchLabel } from './to-arena-labels.ts';

interface ArenaPresentation {
    readonly localCombat: PlayerCombatState;
    readonly localVitals: PlayerVitalsState;
    readonly localLoadout: PlayerLoadoutState;
    readonly setLocalCombat: Dispatch<SetStateAction<PlayerCombatState>>;
    readonly setLocalVitals: Dispatch<SetStateAction<PlayerVitalsState>>;
    readonly setLocalLoadout: Dispatch<SetStateAction<PlayerLoadoutState>>;
    readonly localColor: string;
    readonly matchRemainingMs: number;
    readonly winnerMatch: ArenaMatchState | undefined;
    readonly setDismissedMatchId: Dispatch<SetStateAction<string | undefined>>;
}

export interface ArenaPresentationProps {
    readonly arena: ArenaConnection;
    readonly presentation: ArenaPresentation;
}
interface ArenaSceneProps extends ArenaPresentationProps {
    readonly diagnosticsAttributes: Readonly<Record<string, string>>;
}
interface ArenaHudProps extends ArenaPresentationProps {
    readonly diagnosticsOpen: boolean;
    readonly onToggleDiagnostics: () => void;
    readonly onOpenDiagnostics: () => void;
}

export function useArenaPresentation(arena: ArenaConnection, nowMs: () => number): ArenaPresentation {
    const [localCombat, setLocalCombat] = useState(createInitialCombatState);
    const [localVitals, setLocalVitals] = useState(createInitialVitalsState);
    const [localLoadout, setLocalLoadout] = useState(createInitialLoadoutState);
    const [dismissedMatchId, setDismissedMatchId] = useState<string | undefined>();
    const [clockNow, setClockNow] = useState(nowMs);
    const match = arena.arenaSnapshot?.match;
    useEffect(() => {
        if (match?.status !== 'active') {
            return;
        }
        setDismissedMatchId(undefined);
        const interval = window.setInterval(() => setClockNow(nowMs()), 500);
        return () => window.clearInterval(interval);
    }, [match?.status, match?.matchId, nowMs]);
    return {
        localCombat,
        localVitals,
        localLoadout,
        setLocalCombat,
        setLocalVitals,
        setLocalLoadout,
        localColor: colorForId(arena.session?.sessionId ?? 'local'),
        matchRemainingMs: match?.status === 'active' ? Math.max(0, match.endsAtEpochMs - clockNow) : 0,
        winnerMatch: match?.status === 'complete' && dismissedMatchId !== match.matchId ? match : undefined,
        setDismissedMatchId
    };
}

export function ArenaScene({ arena, presentation, diagnosticsAttributes }: ArenaSceneProps) {
    return (
        <BabylonArena
            localSessionId={arena.session?.sessionId}
            localUsername={arena.session?.username ?? 'hunter'}
            localColor={presentation.localColor}
            roomId={arena.roomId}
            roomReady={arena.connectionState === 'connected' && Boolean(arena.roomId)}
            networkEnabled={arena.networkEnabled}
            linkState={arena.linkState}
            presenceNotices={arena.presenceNotices}
            diagnosticsAttributes={diagnosticsAttributes}
            remotePlayers={arena.remotePlayers}
            remoteShots={arena.remoteShots}
            remotePlayerHits={arena.remotePlayerHits}
            remoteEvents={arena.remoteEvents}
            arenaSnapshot={arena.arenaSnapshot}
            onLocalPose={arena.sendPose}
            onLocalShot={arena.sendShot}
            onPlayerHitIntent={arena.sendPlayerHit}
            onPickupIntent={arena.sendPickupIntent}
            onLocalCombatChange={presentation.setLocalCombat}
            onLocalPlayerChange={(player) => {
                presentation.setLocalVitals(player.vitals);
                presentation.setLocalLoadout(player.loadout);
            }}
            onArenaSnapshot={arena.publishArenaSnapshot}
        />
    );
}

export function ArenaHud(
    { arena, presentation, diagnosticsOpen, onToggleDiagnostics, onOpenDiagnostics }: ArenaHudProps
) {
    const [linkDetailsOpen, setLinkDetailsOpen] = useState(false);
    const currentRoom = arena.rooms.find((room) => room.roomId === arena.roomId);
    const rows = toHudRows(arena, presentation);
    return (
        <section className="hud hud--top">
            <div className="brand">
                <span className="brand__mark" />
                <div>
                    <h1>AR Eye Hunter</h1>
                    <p>{currentRoom?.name ?? 'No arena room selected'}</p>
                </div>
            </div>
            <div className="status-strip">
                {rows.map(([label, value]) => (
                    <div className="status-pill" key={label}>
                        <span>{label}</span>
                        <strong>{value}</strong>
                    </div>
                ))}
                <SquadLinkChip
                    linkState={arena.linkState}
                    open={linkDetailsOpen}
                    onToggle={() => setLinkDetailsOpen((open) => !open)}
                    onOpenDiagnostics={() => {
                        onOpenDiagnostics();
                        setLinkDetailsOpen(false);
                    }}
                    directorLabel={toDirectorLabel(arena.directorStatus)}
                />
                <div className="status-pill">
                    <span>Director</span>
                    <strong>{toDirectorLabel(arena.directorStatus)}</strong>
                </div>
                <div className="status-pill">
                    <span>AI</span>
                    <strong>{arena.aiStatus}</strong>
                </div>
                <button
                    type="button"
                    className="diagnostics-toggle"
                    aria-expanded={diagnosticsOpen}
                    onClick={onToggleDiagnostics}
                >
                    Diag
                </button>
            </div>
        </section>
    );
}

export function ArenaPeers({ arena }: Pick<ArenaPresentationProps, 'arena'>) {
    return (
        <section className="hud hud--bottom">
            {[...arena.remotePlayers.values()].map((remote) => (
                <div className="peer-chip" key={remote.pose.sessionId}>
                    <span className="avatar-dot" style={{ background: remote.pose.color }} />
                    <strong>{remote.pose.username}</strong>
                    <span>{remote.pose.vitals ? `${Math.ceil(remote.pose.vitals.health)} hp` : remote.pose.score}</span>
                </div>
            ))}
        </section>
    );
}

function toHudRows(
    arena: ArenaConnection,
    presentation: ArenaPresentationProps['presentation']
): readonly (readonly [string, string])[] {
    const { localCombat, localVitals, localLoadout, matchRemainingMs } = presentation;
    const wave = arena.arenaSnapshot?.wave;
    const hostileEyeCount =
        arena.arenaSnapshot?.targets.filter((target) =>
            target.threat?.kind === 'beam-sentry' || target.threat?.kind === 'boss'
        ).length ?? 0;
    const incomingAttack =
        arena.arenaSnapshot?.attacks.some((attack) => attack.targetSessionId === arena.session?.sessionId) ?? false;
    return [
        ['Arena', arena.connectionState],
        ['Score', String(localCombat.score)],
        ['Health', localVitals.health <= 0 ? 'respawn' : `${Math.ceil(localVitals.health)}/${localVitals.maxHealth}`],
        ['Wave', wave ? `${wave.number} ${wave.phase}` : 'arming'],
        ['Match', toMatchLabel(arena.arenaSnapshot?.match, matchRemainingMs)],
        ['Threats', incomingAttack ? 'incoming' : String(hostileEyeCount)],
        ['Weapon', getWeaponStats(localLoadout.weaponKind).label],
        ['Combo', `x${localCombat.combo}`],
        ['Overdrive', `${Math.round(localCombat.overdrive)}%`]
    ];
}
