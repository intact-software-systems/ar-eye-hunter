import { Temporal } from '@js-temporal/polyfill';
(globalThis as any).Temporal = (globalThis as any).Temporal ?? Temporal;

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import { useRallarArena, type ArenaConnection } from './game/arena-runtime/use-rallar-arena.ts';
import { BabylonArena } from './game/BabylonArena.tsx';
import { colorForId } from './game/color.ts';
import {
    createInitialCombatState,
    createInitialLoadoutState,
    createInitialVitalsState,
    getWeaponStats
} from './game/simulation.ts';
import { GAME_ROOM_NAME, type ArenaMatchState } from './game/types.ts';

type AuthMode = 'login' | 'register';

export default function App() {
    const arena = useRallarArena();
    const [authMode, setAuthMode] = useState<AuthMode>('login');
    const [username, setUsername] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [password, setPassword] = useState('');
    const [localCombat, setLocalCombat] = useState(createInitialCombatState);
    const [localVitals, setLocalVitals] = useState(createInitialVitalsState);
    const [localLoadout, setLocalLoadout] = useState(createInitialLoadoutState);
    const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
    const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
    const [linkDetailsOpen, setLinkDetailsOpen] = useState(false);
    const [dismissedMatchId, setDismissedMatchId] = useState<string | undefined>();
    const [clockNow, setClockNow] = useState(() => Date.now());

    const localColor = useMemo(
        () => colorForId(arena.session?.sessionId ?? 'local'),
        [arena.session?.sessionId]
    );
    const currentRoom = arena.rooms.find((room) => room.roomId === arena.roomId);
    const arenaRooms = arena.rooms.filter((room) =>
        room.name.toLowerCase().includes('eye hunter') ||
        room.name === GAME_ROOM_NAME
    );
    const wave = arena.arenaSnapshot?.wave;
    const match = arena.arenaSnapshot?.match;
    const matchRemainingMs = match?.status === 'active'
        ? Math.max(0, match.endsAtEpochMs - clockNow)
        : 0;
    const winnerMatch = match?.status === 'complete' && dismissedMatchId !== match.matchId
        ? match
        : undefined;
    const hostileEyeCount =
        arena.arenaSnapshot?.targets.filter((target) =>
            target.threat?.kind === 'beam-sentry' || target.threat?.kind === 'boss'
        ).length ?? 0;
    const incomingAttack =
        arena.arenaSnapshot?.attacks.some((attack) => attack.targetSessionId === arena.session?.sessionId) ?? false;
    const rtcReadyPeers = arena.transportDiagnostics.rtc?.readyPeerIds.length ??
        arena.rtcLanes.reduce((sum, lane) => sum + lane.readyPeers, 0);
    const httpStatus = `${arena.httpDiagnostics.apiConfig.status}/${arena.httpDiagnostics.ice.status}`;
    const arenaNetworkEnabled = arena.networkEnabled;
    const arenaDiagnosticsAttributes = {
        'data-arena-director-attempt': arena.directorAttempt.status,
        'data-arena-diagnostics-open': diagnosticsOpen ? 'true' : 'false',
        'data-arena-ws-state': arena.transportDiagnostics.ws?.readyState ?? 'unknown',
        'data-arena-rtc-ready-peers': String(rtcReadyPeers),
        'data-arena-http-status': httpStatus,
        'data-arena-network-enabled': arenaNetworkEnabled ? 'true' : 'false'
    } as const;

    useEffect(() => {
        if (!diagnosticsOpen || !arenaNetworkEnabled) {
            return;
        }
        void arena.refreshDiagnostics({ includeRtcStats: true });
        const interval = window.setInterval(() => {
            void arena.refreshDiagnostics({ includeRtcStats: true });
        }, 4_000);
        return () => window.clearInterval(interval);
    }, [arena.refreshDiagnostics, arenaNetworkEnabled, diagnosticsOpen]);

    useEffect(() => {
        if (match?.status !== 'active') {
            return;
        }
        const interval = window.setInterval(() => setClockNow(Date.now()), 500);
        return () => window.clearInterval(interval);
    }, [match?.status, match?.matchId]);

    useEffect(() => {
        if (match?.status === 'active') {
            setDismissedMatchId(undefined);
        }
    }, [match?.matchId, match?.status]);

    const submitAuth = async (event: FormEvent) => {
        event.preventDefault();
        if (authMode === 'login') {
            await arena.login(username.trim(), password);
            return;
        }

        await arena.register(username.trim(), password, displayName.trim());
    };

    return (
        <main
            className={mobileDrawerOpen ? 'app-root app-root--mobile-drawer-open' : 'app-root'}
            data-mobile-drawer={mobileDrawerOpen ? 'open' : 'closed'}
            {...arenaDiagnosticsAttributes}
        >
            <BabylonArena
                localSessionId={arena.session?.sessionId}
                localUsername={arena.session?.username ?? 'hunter'}
                localColor={localColor}
                roomId={arena.roomId}
                roomReady={arena.connectionState === 'connected' && Boolean(arena.roomId)}
                networkEnabled={arenaNetworkEnabled}
                linkState={arena.linkState}
                presenceNotices={arena.presenceNotices}
                diagnosticsAttributes={arenaDiagnosticsAttributes}
                remotePlayers={arena.remotePlayers}
                remoteShots={arena.remoteShots}
                remotePlayerHits={arena.remotePlayerHits}
                remoteEvents={arena.remoteEvents}
                arenaSnapshot={arena.arenaSnapshot}
                onLocalPose={arena.sendPose}
                onLocalShot={arena.sendShot}
                onPlayerHitIntent={arena.sendPlayerHit}
                onPickupIntent={arena.sendPickupIntent}
                onLocalCombatChange={setLocalCombat}
                onLocalPlayerChange={(player) => {
                    setLocalVitals(player.vitals);
                    setLocalLoadout(player.loadout);
                }}
                onArenaSnapshot={arena.publishArenaSnapshot}
            />

            <section className="hud hud--top">
                <div className="brand">
                    <span className="brand__mark" />
                    <div>
                        <h1>AR Eye Hunter</h1>
                        <p>{currentRoom?.name ?? 'No arena room selected'}</p>
                    </div>
                </div>

                <div className="status-strip">
                    <StatusPill label="Arena" value={arena.connectionState} />
                    <StatusPill label="Score" value={String(localCombat.score)} />
                    <StatusPill
                        label="Health"
                        value={localVitals.health <= 0
                            ? 'respawn'
                            : `${Math.ceil(localVitals.health)}/${localVitals.maxHealth}`}
                    />
                    <StatusPill
                        label="Wave"
                        value={wave ? `${wave.number} ${wave.phase}` : 'arming'}
                    />
                    <StatusPill
                        label="Match"
                        value={matchLabel(match, matchRemainingMs)}
                    />
                    <StatusPill
                        label="Threats"
                        value={incomingAttack ? 'incoming' : String(hostileEyeCount)}
                    />
                    <StatusPill
                        label="Weapon"
                        value={getWeaponStats(localLoadout.weaponKind).label}
                    />
                    <StatusPill label="Combo" value={`x${localCombat.combo}`} />
                    <StatusPill
                        label="Overdrive"
                        value={`${Math.round(localCombat.overdrive)}%`}
                    />
                    <SquadLinkChip
                        linkState={arena.linkState}
                        open={linkDetailsOpen}
                        onToggle={() => setLinkDetailsOpen((open) => !open)}
                        onOpenDiagnostics={() => {
                            setDiagnosticsOpen(true);
                            setLinkDetailsOpen(false);
                        }}
                        directorLabel={directorLabel(arena.directorStatus)}
                    />
                    <StatusPill
                        label="Director"
                        value={directorLabel(arena.directorStatus)}
                    />
                    <StatusPill
                        label="AI"
                        value={arena.aiStatus}
                    />
                    <button
                        type="button"
                        className="diagnostics-toggle"
                        aria-expanded={diagnosticsOpen}
                        onClick={() => setDiagnosticsOpen((open) => !open)}
                    >
                        Diag
                    </button>
                </div>
            </section>

            <PresenceToastStack
                notices={arena.presenceNotices}
                onDismiss={arena.dismissPresenceNotice}
            />

            <button
                type="button"
                className="mobile-drawer-toggle"
                aria-expanded={mobileDrawerOpen}
                onClick={() => setMobileDrawerOpen((open) => !open)}
            >
                {mobileDrawerOpen ? 'Close Ops' : 'Ops'}
            </button>

            <section className="hud hud--side" aria-label="Arena operations">
                {arena.connectionState === 'signed-out' || !arena.session
                    ? (
                        <form className="panel stack" onSubmit={submitAuth}>
                            <div className="segmented">
                                <button
                                    type="button"
                                    className={authMode === 'login' ? 'active' : ''}
                                    onClick={() => setAuthMode('login')}
                                >
                                    Login
                                </button>
                                <button
                                    type="button"
                                    className={authMode === 'register' ? 'active' : ''}
                                    onClick={() => setAuthMode('register')}
                                >
                                    Register
                                </button>
                            </div>
                            <label>
                                Username
                                <input
                                    autoComplete="username"
                                    value={username}
                                    onChange={(event) => setUsername(event.target.value)}
                                />
                            </label>
                            {authMode === 'register' && (
                                <label>
                                    Display name
                                    <input
                                        value={displayName}
                                        onChange={(event) => setDisplayName(event.target.value)}
                                    />
                                </label>
                            )}
                            <label>
                                Password
                                <input
                                    autoComplete={authMode === 'login'
                                        ? 'current-password'
                                        : 'new-password'}
                                    type="password"
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                />
                            </label>
                            <button
                                type="submit"
                                className="primary"
                                disabled={!username.trim() || !password}
                            >
                                {authMode === 'login' ? 'Enter Arena' : 'Create Hunter'}
                            </button>
                        </form>
                    )
                    : (
                        <div className="panel stack">
                            <div className="profile-row">
                                <span
                                    className="avatar-dot"
                                    style={{ background: localColor }}
                                />
                                <div>
                                    <strong>{arena.session.username}</strong>
                                    <span>{shortId(arena.session.sessionId)}</span>
                                </div>
                            </div>

                            <div className="room-actions">
                                <button type="button" onClick={arena.createArenaRoom}>
                                    New Arena
                                </button>
                                <button type="button" onClick={arena.refreshRooms}>
                                    Refresh
                                </button>
                                <button type="button" onClick={arena.logout}>
                                    Logout
                                </button>
                            </div>

                            <div className="director-panel">
                                <div>
                                    <span>Director</span>
                                    <strong>{directorLabel(arena.directorStatus)}</strong>
                                </div>
                                <button
                                    type="button"
                                    className="primary"
                                    disabled={!arena.roomId ||
                                        arena.directorStatus.isDirector ||
                                        arena.directorAttempt.status === 'pending'}
                                    onClick={arena.appointSelfAsDirector}
                                >
                                    {arena.directorAttempt.status === 'pending'
                                        ? 'Appointing...'
                                        : 'Appoint this SPA'}
                                </button>
                            </div>
                            {arena.directorAttempt.status !== 'idle' && (
                                <p className="attempt-note">
                                    {directorAttemptLabel(arena.directorAttempt)}
                                </p>
                            )}

                            <div className="match-panel">
                                <div>
                                    <span>Match</span>
                                    <strong>{matchLabel(match, matchRemainingMs)}</strong>
                                </div>
                                <div className="match-buttons">
                                    {([60_000, 180_000, 300_000] as const).map((duration) => (
                                        <button
                                            type="button"
                                            key={duration}
                                            disabled={!arena.directorStatus.isDirector ||
                                                !arena.directorStatus.isFresh ||
                                                match?.status === 'active'}
                                            onClick={() => void arena.startArenaMatch(duration)}
                                        >
                                            {duration / 60_000}m
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="director-panel director-panel--event">
                                <div>
                                    <span>Chaos</span>
                                    <strong>{arena.activeEvent?.headline ?? 'arming'}</strong>
                                </div>
                                <span className="event-kind">
                                    {arena.activeEvent?.kind ?? arena.aiStatus}
                                </span>
                            </div>

                            <div className="room-list">
                                {arenaRooms.length === 0 && (
                                    <p className="muted">
                                        Create an arena or join from another browser session.
                                    </p>
                                )}
                                {arenaRooms.map((room) => (
                                    <button
                                        type="button"
                                        key={room.roomId}
                                        className={room.roomId === arena.roomId
                                            ? 'room-row active'
                                            : 'room-row'}
                                        onClick={() => arena.joinRoom(room.roomId)}
                                    >
                                        <span>{room.name}</span>
                                        <small>{room.onlineMemberCount} online</small>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                {arena.error && (
                    <div className="panel error-panel">
                        {arena.error}
                    </div>
                )}

                <div className="panel compact">
                    <div className="control-grid">
                        <span>WASD</span>
                        <span>Move</span>
                        <span>Shift</span>
                        <span>Sprint</span>
                        <span>E</span>
                        <span>Dash</span>
                        <span>C/Ctrl</span>
                        <span>Slide</span>
                        <span>Space</span>
                        <span>Jump</span>
                        <span>Mouse</span>
                        <span>Look</span>
                        <span>Click</span>
                        <span>Fire</span>
                        <span>Right click</span>
                        <span>Scan</span>
                    </div>
                </div>
            </section>

            <section className="hud hud--bottom">
                {[...arena.remotePlayers.values()].map((remote) => (
                    <div className="peer-chip" key={remote.pose.sessionId}>
                        <span
                            className="avatar-dot"
                            style={{ background: remote.pose.color }}
                        />
                        <strong>{remote.pose.username}</strong>
                        <span>
                            {remote.pose.vitals
                                ? `${Math.ceil(remote.pose.vitals.health)} hp`
                                : remote.pose.score}
                        </span>
                    </div>
                ))}
            </section>

            {diagnosticsOpen && (
                <DiagnosticsDrawer
                    arena={arena}
                    onClose={() => setDiagnosticsOpen(false)}
                />
            )}

            {winnerMatch && (
                <MatchWinnerOverlay
                    match={winnerMatch}
                    onClose={() => setDismissedMatchId(winnerMatch.matchId)}
                />
            )}
        </main>
    );
}

function StatusPill({ label, value }: Readonly<{ label: string; value: string; }>) {
    return (
        <div className="status-pill">
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

function SquadLinkChip({
    linkState,
    open,
    onToggle,
    onOpenDiagnostics,
    directorLabel
}: Readonly<{
    linkState: ArenaConnection['linkState'];
    open: boolean;
    onToggle: () => void;
    onOpenDiagnostics: () => void;
    directorLabel: string;
}>) {
    return (
        <div className="squad-link" data-tone={linkState.tone}>
            <button
                type="button"
                className="squad-link__button"
                aria-expanded={open}
                onClick={onToggle}
            >
                <span>Squad Link</span>
                <strong>{linkState.label}</strong>
            </button>
            {open && (
                <div className="squad-link__popover">
                    <strong>{linkState.detail}</strong>
                    <span>
                        {linkState.playerCount} hunter{linkState.playerCount === 1 ? '' : 's'} in this signal mess.
                    </span>
                    <span>Arena host: {directorLabel}</span>
                    <button type="button" onClick={onOpenDiagnostics}>
                        Open diagnostics
                    </button>
                </div>
            )}
        </div>
    );
}

function PresenceToastStack({
    notices,
    onDismiss
}: Readonly<{
    notices: ArenaConnection['presenceNotices'];
    onDismiss: (id: string) => void;
}>) {
    if (notices.length === 0) {
        return null;
    }
    return (
        <div className="presence-toasts" aria-live="polite" aria-label="Squad link updates">
            {notices.slice(-4).map((notice) => (
                <button
                    type="button"
                    key={notice.id}
                    className="presence-toast"
                    data-kind={notice.kind}
                    onClick={() => onDismiss(notice.id)}
                >
                    <span>{notice.message}</span>
                </button>
            ))}
        </div>
    );
}

function directorLabel(
    status: Readonly<{
        role: string;
        state: string;
        isDirector: boolean;
    }>
): string {
    if (status.state === 'none') {
        return 'peer mode';
    }
    if (status.isDirector) {
        return status.state === 'fresh' ? 'you' : `you ${status.state}`;
    }
    return status.state;
}

function matchLabel(
    match: ArenaMatchState | undefined,
    remainingMs: number
): string {
    if (!match) {
        return 'infinite';
    }
    if (match.status === 'active') {
        return formatDuration(remainingMs);
    }
    const winner = match.results?.[0];
    return winner ? `${winner.username} won` : 'complete';
}

function formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function shortId(id: string): string {
    return id.length <= 8 ? id : id.slice(0, 8);
}

function MatchWinnerOverlay({
    match,
    onClose
}: Readonly<{
    match: ArenaMatchState;
    onClose: () => void;
}>) {
    const winner = match.results?.[0];
    return (
        <section className="match-winner" role="dialog" aria-modal="false" aria-label="Match results">
            <div className="match-winner__panel">
                <span className="match-winner__eyebrow">Arena Match Complete</span>
                <h2>{winner ? `${winner.username} survives the metrics` : 'The metrics are inconclusive'}</h2>
                <p>
                    {winner
                        ? `${winner.scoreDelta} score, ${winner.killsDelta} eliminations, ${winner.deathsDelta} deaths. HR calls this character building.`
                        : 'Nobody won, which is legally cheaper.'}
                </p>
                <div className="match-results">
                    {(match.results ?? []).slice(0, 5).map((standing) => (
                        <div className="match-result-row" key={standing.sessionId}>
                            <strong>#{standing.rank} {standing.username}</strong>
                            <span>{standing.scoreDelta} pts</span>
                            <span>{standing.killsDelta} K</span>
                            <span>{standing.deathsDelta} D</span>
                        </div>
                    ))}
                </div>
                <button type="button" className="primary" onClick={onClose}>
                    Continue infinite chaos
                </button>
            </div>
        </section>
    );
}

function DiagnosticsDrawer({
    arena,
    onClose
}: Readonly<{
    arena: ArenaConnection;
    onClose: () => void;
}>) {
    const [copied, setCopied] = useState(false);
    const diagnosticsJson = useMemo(
        () =>
            JSON.stringify(
                {
                    directorAttempt: arena.directorAttempt,
                    directorStatus: arena.directorStatus,
                    match: arena.gameDiagnostics,
                    transport: arena.transportDiagnostics,
                    http: arena.httpDiagnostics,
                    link: arena.linkState,
                    lanes: arena.rtcLanes,
                    lifecycle: {
                        authStorageKind: arena.authStorageKind,
                        authGeneration: arena.authGeneration,
                        networkEnabled: arena.networkEnabled,
                        logoutQuiesced: arena.logoutQuiesced,
                        wsTicketBackoff: arena.transportDiagnostics.wsTicketBackoff
                    },
                    ai: {
                        status: arena.aiStatus,
                        error: arena.aiError
                    }
                },
                null,
                2
            ),
        [
            arena.aiError,
            arena.aiStatus,
            arena.directorAttempt,
            arena.directorStatus,
            arena.gameDiagnostics,
            arena.httpDiagnostics,
            arena.linkState,
            arena.authGeneration,
            arena.authStorageKind,
            arena.logoutQuiesced,
            arena.rtcLanes,
            arena.networkEnabled,
            arena.transportDiagnostics
        ]
    );

    const copyDiagnostics = async () => {
        if (!navigator.clipboard) {
            return;
        }
        await navigator.clipboard.writeText(diagnosticsJson);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_200);
    };

    return (
        <aside className="diagnostics-drawer" aria-label="Arena diagnostics">
            <div className="diagnostics-header">
                <div>
                    <span>Diagnostics</span>
                    <strong>{arena.roomId ? shortId(arena.roomId) : 'no room'}</strong>
                </div>
                <button type="button" onClick={onClose}>Close</button>
            </div>

            <div className="diagnostics-actions">
                <button
                    type="button"
                    disabled={!arena.networkEnabled || !arena.roomId ||
                        arena.directorAttempt.status === 'pending'}
                    onClick={arena.appointSelfAsDirector}
                >
                    Retry appoint
                </button>
                <button
                    type="button"
                    disabled={!arena.networkEnabled}
                    onClick={() => arena.refreshDiagnostics({ includeRtcStats: true })}
                >
                    Refresh
                </button>
                <button
                    type="button"
                    disabled={!arena.networkEnabled}
                    onClick={arena.requestArenaSync}
                >
                    Request sync
                </button>
            </div>

            <DiagnosticsSection title="Director">
                <DiagnosticsRow label="Role" value={directorLabel(arena.directorStatus)} />
                <DiagnosticsRow label="Fresh" value={arena.directorStatus.isFresh ? 'yes' : 'no'} />
                <DiagnosticsRow label="Attempt" value={directorAttemptLabel(arena.directorAttempt)} />
                <DiagnosticsRow
                    label="Heartbeat"
                    value={arena.directorStatus.lastHeartbeatAtEpochMs
                        ? `${Date.now() - arena.directorStatus.lastHeartbeatAtEpochMs} ms ago`
                        : 'none'}
                />
            </DiagnosticsSection>

            <DiagnosticsSection title="Match Election">
                <DiagnosticsRow label="Phase" value={arena.gameDiagnostics?.phase ?? 'unknown'} />
                <DiagnosticsRow
                    label="Authority"
                    value={arena.gameDiagnostics?.directorAuthority ?? 'unknown'}
                />
                <DiagnosticsRow
                    label="Eligibility"
                    value={arena.gameDiagnostics?.appointment?.status ?? 'unknown'}
                />
                <DiagnosticsRow
                    label="Local role"
                    value={arena.gameDiagnostics?.appointment?.localRole ?? 'unknown'}
                />
                <DiagnosticsRow label="Host" value={shortOptional(arena.gameDiagnostics?.hostPeerId)} />
                <DiagnosticsRow label="Director" value={shortOptional(arena.gameDiagnostics?.directorPeerId)} />
                <DiagnosticsRow label="Ready peers" value={String(arena.gameDiagnostics?.readyPeerIds.length ?? 0)} />
                <DiagnosticsRow
                    label="Issues"
                    value={arena.gameDiagnostics?.issues.join(', ') || 'none'}
                />
            </DiagnosticsSection>

            <DiagnosticsSection title="RTC / Realtime">
                <DiagnosticsRow label="Squad Link" value={`${arena.linkState.label} (${arena.linkState.tone})`} />
                <DiagnosticsRow
                    label="Reliable"
                    value={arena.gameDiagnostics?.egress.reliable ?? 'unknown'}
                />
                <DiagnosticsRow
                    label="RTC"
                    value={arena.gameDiagnostics?.egress.realtime ?? 'unknown'}
                />
                <DiagnosticsRow label="WS" value={arena.transportDiagnostics.ws?.readyState ?? 'unknown'} />
                <DiagnosticsRow
                    label="WS ticket"
                    value={wsTicketBackoffLabel(arena.transportDiagnostics.wsTicketBackoff)}
                />
                <DiagnosticsRow
                    label="RTC peers"
                    value={`${arena.transportDiagnostics.rtc?.readyPeerIds.length ?? 0}/${
                        arena.transportDiagnostics.rtc?.knownPeerIds.length ?? 0
                    }`}
                />
                <DiagnosticsRow
                    label="Relay peers"
                    value={String(arena.transportDiagnostics.rtcDiagnostics?.relayPeerCount ?? 0)}
                />
                <DiagnosticsRow
                    label="Realtime lanes"
                    value={String(arena.transportDiagnostics.realtimeHealth.length)}
                />
                <div className="lane-list">
                    {arena.rtcLanes.map((lane) => (
                        <span key={lane.laneId} data-state={lane.status}>
                            {lane.laneId}: {lane.status} {lane.readyPeers}/{lane.readyPeers + lane.notReadyPeers}
                        </span>
                    ))}
                </div>
            </DiagnosticsSection>

            <DiagnosticsSection title="HTTP / API">
                <DiagnosticsRow label="Auth storage" value={arena.authStorageKind} />
                <DiagnosticsRow label="Generation" value={String(arena.authGeneration)} />
                <DiagnosticsRow label="Network" value={arena.networkEnabled ? 'enabled' : 'disabled'} />
                <DiagnosticsRow label="Logout" value={arena.logoutQuiesced ? 'quiesced' : 'active'} />
                <DiagnosticsRow
                    label="Config"
                    value={httpProbeLabel(arena.httpDiagnostics.apiConfig)}
                />
                <DiagnosticsRow
                    label="ICE"
                    value={httpProbeLabel(arena.httpDiagnostics.ice)}
                />
            </DiagnosticsSection>

            <DiagnosticsSection title="Recent Events">
                <DiagnosticsRow label="Remote players" value={String(arena.remotePlayers.size)} />
                <DiagnosticsRow label="Remote events" value={String(arena.remoteEvents.length)} />
                <DiagnosticsRow label="Shots" value={String(arena.remoteShots.length)} />
                <DiagnosticsRow label="Hits" value={String(arena.remotePlayerHits.length)} />
            </DiagnosticsSection>

            <details className="diagnostics-json">
                <summary>JSON</summary>
                <button type="button" onClick={copyDiagnostics}>
                    {copied ? 'Copied' : 'Copy JSON'}
                </button>
                <pre>{diagnosticsJson}</pre>
            </details>
        </aside>
    );
}

function DiagnosticsSection({
    title,
    children
}: Readonly<{
    title: string;
    children: ReactNode;
}>) {
    return (
        <section className="diagnostics-section">
            <h2>{title}</h2>
            {children}
        </section>
    );
}

function DiagnosticsRow({
    label,
    value
}: Readonly<{
    label: string;
    value: string;
}>) {
    return (
        <div className="diagnostics-row">
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

function directorAttemptLabel(attempt: ArenaConnection['directorAttempt']): string {
    if (attempt.status === 'idle') {
        return 'idle';
    }
    if (attempt.status === 'pending') {
        return `${attempt.source ?? 'manual'} pending`;
    }
    const detail = attempt.reason ? `: ${attempt.reason}` : '';
    return `${attempt.source ?? 'manual'} ${attempt.status}${detail}`;
}

function httpProbeLabel(probe: ArenaConnection['httpDiagnostics']['apiConfig']): string {
    if (probe.status === 'idle') {
        return 'idle';
    }
    const timing = probe.durationMs === undefined ? '' : ` ${probe.durationMs}ms`;
    const detail = probe.detail || probe.reason;
    return `${probe.status}${timing}${detail ? ` ${detail}` : ''}`;
}

function wsTicketBackoffLabel(
    state: ArenaConnection['transportDiagnostics']['wsTicketBackoff']
): string {
    if (!state || state.status === 'idle') {
        return 'idle';
    }
    if (state.status === 'local-rate-limited') {
        return 'local throttle';
    }
    if (state.status === 'circuit-open') {
        return 'circuit open';
    }
    return `cooldown ${Math.max(0, state.retryAtEpochMs - Date.now())}ms`;
}

function shortOptional(value: string | undefined): string {
    return value ? shortId(value) : 'none';
}
