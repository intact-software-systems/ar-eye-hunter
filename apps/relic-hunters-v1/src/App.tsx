import { Temporal } from '@js-temporal/polyfill';
(globalThis as any).Temporal = (globalThis as any).Temporal ?? Temporal;

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
    RelicActionInput,
    RelicActionKind,
    RelicCharacterId,
    RelicEvent,
    RelicEventType,
    RelicPlayer,
    RelicPublicSnapshot,
} from '@relic-hunters/mod.ts';
import { RELIC_CHARACTERS, findRelicCharacter } from '@relic-hunters/mod.ts';
import { RelicScene } from './game/RelicScene.tsx';
import { useRelicHunters } from './game/useRelicHunters.ts';
import { colorForId } from './game/color.ts';
import {
    isAmbientSoundPlaying,
    playActionSound,
    playRelicEventSound,
    playUiSound,
    startAmbientSound,
    stopAmbientSound,
} from './game/sound.ts';

type AuthMode = 'login' | 'register';
type ActionDraft = Readonly<{
    kind: RelicActionInput['kind'];
    targetRoomId?: string;
    targetPlayerId?: string;
}>;

export default function App() {
    const game = useRelicHunters();
    const playedEventIdsRef = useRef<Set<string>>(new Set());
    const [authMode, setAuthMode] = useState<AuthMode>('login');
    const [username, setUsername] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [password, setPassword] = useState('');
    const [selectedRoomId, setSelectedRoomId] = useState<string | undefined>();
    const [selectedCharacterId, setSelectedCharacterId] = useState<RelicCharacterId>(
        RELIC_CHARACTERS[0].id,
    );
    const [draft, setDraft] = useState<ActionDraft>({ kind: 'search' });
    const [scenePrimedAction, setScenePrimedAction] = useState<RelicActionInput | undefined>();
    const [dismissedPartyChangeKey, setDismissedPartyChangeKey] = useState<string | undefined>();
    const [ambientEnabled, setAmbientEnabled] = useState(false);
    const [revealedEvents, setRevealedEvents] = useState<readonly RelicEvent[]>([]);
    const [showOnboarding, setShowOnboarding] = useState(
        () => !localStorage.getItem('relic-onboarding-v1'),
    );
    const [digestEvents, setDigestEvents] = useState<readonly RelicEvent[]>([]);
    const [showDigest, setShowDigest] = useState(false);
    const lastDigestEventIdRef = useRef<string | undefined>(undefined);
    const [personalFlash, setPersonalFlash] = useState<{ tone: 'good' | 'bad'; key: number } | null>(null);
    const personalFlashKeyRef = useRef(0);
    const [lockedAction, setLockedAction] = useState<RelicActionInput | undefined>();
    const [showTensionBeat, setShowTensionBeat] = useState(false);
    const [showHelpOverlay, setShowHelpOverlay] = useState(false);
    const [sidePanelCollapsed, setSidePanelCollapsed] = useState(false);
    const [phaseBanner, setPhaseBanner] = useState<string | null>(null);
    const [roomEntryFlash, setRoomEntryFlash] = useState<{ room: string; key: number } | null>(null);
    const roomEntryKeyRef = useRef(0);
    const prevPhaseRef = useRef<RelicPublicSnapshot['phase'] | undefined>(undefined);
    const prevRoomIdRef = useRef<string | undefined>(undefined);
    const tensionTimerRef = useRef<number | null>(null);
    const revealQueueRef = useRef<RelicEvent[]>([]);
    const revealTimerRef = useRef<number | null>(null);
    const revealNextRef = useRef<() => void>(null!);

    const currentPlayer = useMemo(
        () =>
            game.snapshot?.players.find((player) =>
                player.playerId === game.session?.sessionId
            ),
        [game.session?.sessionId, game.snapshot?.players],
    );
    const currentRoom = game.snapshot?.map.find((room) =>
        room.id === currentPlayer?.roomId
    );
    const currentRoomSummary = useMemo(
        () => game.rooms.find((room) => room.roomId === game.roomId),
        [game.roomId, game.rooms],
    );
    const selectedCharacter = findRelicCharacter(
        currentPlayer && game.snapshot?.phase !== 'lobby'
            ? currentPlayer.characterId
            : selectedCharacterId,
    );
    const moveTargets = currentPlayer && game.snapshot
        ? game.snapshot.map
            .filter((room) => currentRoom?.neighbors.includes(room.id) && !room.collapsed)
            .map((room) => room.id)
        : [];
    const exitDistances = useMemo(
        () => game.snapshot ? castleMapExitDistances(game.snapshot.map) : new Map<string, number>(),
        [game.snapshot],
    );
    const stealTargets = game.snapshot?.players.filter((player) =>
        currentPlayer &&
        player.playerId !== currentPlayer.playerId &&
        player.roomId === currentPlayer.roomId &&
        !player.escaped &&
        !player.defeated
    ) ?? [];
    const rooms = game.rooms.filter((room) =>
        room.name.toLowerCase().includes('relic hunters')
    );
    const lastEvent = revealedEvents.at(-1);
    const eventFocusRoomId = useMemo(() => {
        if (!lastEvent || !game.snapshot) return undefined;
        if (!isTurnResultEvent(lastEvent) && lastEvent.type !== 'action_revealed') return undefined;
        if (lastEvent.animationCue?.roomId) return lastEvent.animationCue.roomId;
        if (lastEvent.animationCue?.playerId) {
            return game.snapshot.players.find(
                (p) => p.playerId === lastEvent.animationCue?.playerId,
            )?.roomId;
        }
        return undefined;
    }, [lastEvent, game.snapshot]);
    const progress = game.snapshot
        ? toProgress(game.snapshot, currentPlayer?.playerId)
        : undefined;
    const partyCoordination = game.snapshot
        ? derivePartyCoordination(game.snapshot, game.session?.sessionId, draft.kind)
        : undefined;
    const objective = game.snapshot
        ? toObjective(game.snapshot, currentPlayer)
        : 'Create or join a room to begin the expedition.';
    const actionInfo = ACTION_INFO[draft.kind];
    const submitBlocker = game.snapshot && currentPlayer
        ? actionBlocker(game.snapshot, currentPlayer, draft, moveTargets, stealTargets)
        : undefined;
    const canSubmit = !!game.snapshot &&
        game.snapshot.phase === 'planning' &&
        !!currentPlayer &&
        !game.snapshot.submittedPlayerIds.includes(currentPlayer.playerId) &&
        !submitBlocker;
    const isLocked = !!(currentPlayer && game.snapshot &&
        game.snapshot.submittedPlayerIds.includes(currentPlayer.playerId));
    const roundNoiseCount = game.snapshot
        ? revealedEvents.filter(
            (e) => e.round === game.snapshot!.round - 1 && e.type === 'noise_pulse',
        ).length
        : 0;
    const partyChangeKey = game.snapshot &&
            currentRoomSummary &&
            game.snapshot.phase !== 'finished' &&
            game.snapshot.players.length > 0 &&
            currentRoomSummary.onlineMemberCount !== game.snapshot.players.length
        ? [
            game.roomId,
            game.snapshot.players.length,
            currentRoomSummary.onlineMemberCount,
        ].join(':')
        : undefined;
    const showPartyChangePrompt = !!partyChangeKey &&
        partyChangeKey !== dismissedPartyChangeKey &&
        !!game.session &&
        !!game.roomId;

    // Latest-ref pattern: updated each render so the timer closure always calls the current version.
    revealNextRef.current = () => {
        const next = revealQueueRef.current.shift();
        if (!next) return;
        setRevealedEvents((prev) => [...prev, next]);
        playRelicEventSound(next);
        if (isPersonalEvent(next, game.session?.sessionId)) {
            personalFlashKeyRef.current += 1;
            setPersonalFlash({
                tone: next.tone === 'danger' ? 'bad' : 'good',
                key: personalFlashKeyRef.current,
            });
        }
        if (revealQueueRef.current.length > 0) {
            revealTimerRef.current = window.setTimeout(() => {
                revealTimerRef.current = null;
                revealNextRef.current();
            }, 750);
        }
    };

    const scheduleReveal = useCallback(() => {
        if (revealTimerRef.current !== null || revealQueueRef.current.length === 0) return;
        revealTimerRef.current = window.setTimeout(() => {
            revealTimerRef.current = null;
            revealNextRef.current();
        }, 400);
    }, []);

    useEffect(() => {
        const events = game.snapshot?.events ?? [];
        const seen = playedEventIdsRef.current;

        if (seen.size === 0) {
            // First load: show all historical events immediately, no animation.
            for (const event of events) seen.add(event.id);
            setRevealedEvents(events);
            return;
        }

        const newEvents: RelicEvent[] = [];
        for (const event of events) {
            if (!seen.has(event.id)) {
                seen.add(event.id);
                newEvents.push(event);
            }
        }

        if (newEvents.length > 0) {
            const wasIdle = revealQueueRef.current.length === 0 && revealTimerRef.current === null;
            revealQueueRef.current.push(...newEvents);
            const hasTurnEvents = newEvents.some(
                (e) => isTurnResultEvent(e) || e.type === 'action_revealed',
            );
            if (wasIdle && hasTurnEvents) {
                setShowTensionBeat(true);
                tensionTimerRef.current = window.setTimeout(() => {
                    tensionTimerRef.current = null;
                    setShowTensionBeat(false);
                    scheduleReveal();
                }, 1200);
            } else {
                scheduleReveal();
            }
        }
    }, [game.snapshot?.events, scheduleReveal]);

    useEffect(() => {
        return () => {
            if (revealTimerRef.current !== null) clearTimeout(revealTimerRef.current);
            if (tensionTimerRef.current !== null) clearTimeout(tensionTimerRef.current);
        };
    }, []);

    useEffect(() => {
        setLockedAction(undefined);
    }, [game.snapshot?.round]);

    // Show post-round digest when reveal queue drains on a round_started event.
    useEffect(() => {
        if (revealQueueRef.current.length > 0 || revealTimerRef.current !== null) return;
        const lastRevealed = revealedEvents.at(-1);
        if (!lastRevealed || lastRevealed.type !== 'round_started') return;
        if (lastRevealed.id === lastDigestEventIdRef.current) return;
        if (game.snapshot?.phase === 'finished') return;
        let prevRoundStartedIdx = -1;
        for (let i = revealedEvents.length - 2; i >= 0; i--) {
            if (revealedEvents[i].type === 'round_started') { prevRoundStartedIdx = i; break; }
        }
        const roundEvents = revealedEvents
            .slice(prevRoundStartedIdx + 1, revealedEvents.length - 1)
            .filter(isTurnResultEvent);
        if (roundEvents.length === 0) return;
        lastDigestEventIdRef.current = lastRevealed.id;
        setDigestEvents(roundEvents);
        setShowDigest(true);
    }, [revealedEvents, game.snapshot?.phase]);

    useEffect(() => {
        if (!showDigest) return;
        const timer = window.setTimeout(() => setShowDigest(false), 4000);
        return () => clearTimeout(timer);
    }, [showDigest]);

    useEffect(() => {
        if (currentPlayer) {
            setSelectedCharacterId(currentPlayer.characterId);
        }
    }, [currentPlayer?.characterId]);

    useEffect(() => {
        if (!game.session) {
            stopAmbientSound();
            setAmbientEnabled(false);
        }
    }, [game.session]);

    useEffect(() => {
        setScenePrimedAction(undefined);
    }, [currentPlayer?.roomId, game.snapshot?.phase, game.snapshot?.round]);

    useEffect(() => {
        const phase = game.snapshot?.phase;
        if (!phase) { prevPhaseRef.current = undefined; return; }
        if (prevPhaseRef.current && prevPhaseRef.current !== phase) {
            const msg = phase === 'planning' ? 'The expedition begins!'
                : phase === 'finished' ? 'The ruin falls silent.'
                : null;
            if (msg) {
                setPhaseBanner(msg);
                const t = window.setTimeout(() => setPhaseBanner(null), 2400);
                return () => clearTimeout(t);
            }
        }
        prevPhaseRef.current = phase;
    }, [game.snapshot?.phase]);

    useEffect(() => {
        const roomId = currentPlayer?.roomId;
        if (!roomId) { prevRoomIdRef.current = undefined; return; }
        if (prevRoomIdRef.current !== undefined && prevRoomIdRef.current !== roomId) {
            const room = game.snapshot?.map.find((r) => r.id === roomId);
            if (room) {
                roomEntryKeyRef.current += 1;
                setRoomEntryFlash({ room: room.name, key: roomEntryKeyRef.current });
            }
        }
        prevRoomIdRef.current = roomId;
    }, [currentPlayer?.roomId, game.snapshot?.map]);

    const submitAuth = async (event: FormEvent) => {
        event.preventDefault();
        if (authMode === 'login') {
            await game.login(username.trim(), password);
            return;
        }

        await game.register(username.trim(), password, displayName.trim());
    };

    const submitAction = async () => {
        const selectedMoveTarget = selectedRoomId && moveTargets.includes(selectedRoomId)
            ? selectedRoomId
            : undefined;
        const action: RelicActionInput = draft.kind === 'move'
            ? {
                kind: 'move',
                targetRoomId: draft.targetRoomId ?? selectedMoveTarget ?? moveTargets[0],
            }
            : draft.kind === 'steal'
            ? {
                kind: 'steal',
                targetPlayerId: draft.targetPlayerId ?? stealTargets[0]?.playerId,
            }
            : { kind: draft.kind };

        setLockedAction(action);
        playActionSound(action.kind);
        if (!isAmbientSoundPlaying()) {
            setAmbientEnabled(startAmbientSound());
        }
        await game.submitAction(action);
    };

    // Stable ref so the keyboard handler always calls the latest submitAction.
    const submitActionRef = useRef(submitAction);
    submitActionRef.current = submitAction;

    useEffect(() => {
        const ACTION_KEYS: Record<string, RelicActionKind> = {
            '1': 'move', '2': 'search', '3': 'steal', '4': 'escape',
        };
        const handler = (e: KeyboardEvent) => {
            const target = e.target;
            const isTyping = target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                (target instanceof HTMLElement && target.isContentEditable);
            if (isTyping) return;
            if (!game.snapshot || game.snapshot.phase !== 'planning') return;

            const kind = ACTION_KEYS[e.key] as RelicActionKind | undefined;
            if (kind) {
                e.preventDefault();
                playUiSound('select');
                setDraft((prev) => {
                    if (prev.kind === kind) return prev;
                    if (kind === 'move') return { kind, targetRoomId: moveTargets[0] };
                    if (kind === 'steal') return { kind, targetPlayerId: stealTargets[0]?.playerId };
                    return { kind };
                });
                return;
            }

            if (e.key === 'Enter' && canSubmit) {
                e.preventDefault();
                void submitActionRef.current();
            }

            if (e.key === '?' || e.key === 'F1') {
                e.preventDefault();
                setShowHelpOverlay((v) => !v);
            }

            if (e.key === 'Escape') {
                setShowHelpOverlay(false);
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [game.snapshot, canSubmit, moveTargets, stealTargets]);

    const joinExpedition = async () => {
        playUiSound('join');
        setAmbientEnabled(startAmbientSound());
        await game.joinExpedition(selectedCharacterId);
    };

    const startExpedition = async () => {
        playUiSound('start');
        setAmbientEnabled(startAmbientSound());
        await game.startExpedition();
    };

    const resetExpedition = async () => {
        playUiSound('reset');
        setDismissedPartyChangeKey(undefined);
        await game.resetExpedition();
    };

    const primeSceneAction = (action: RelicActionInput) => {
        playUiSound('select');
        if (action.kind === 'move' && action.targetRoomId) {
            setSelectedRoomId(action.targetRoomId);
            setDraft({
                kind: 'move',
                targetRoomId: action.targetRoomId,
            });
            setScenePrimedAction(action);
            return;
        }

        if (action.kind === 'search') {
            setDraft({ kind: 'search' });
            setScenePrimedAction(action);
            return;
        }

        if (action.kind === 'escape') {
            setDraft({ kind: 'escape' });
            setScenePrimedAction(action);
            return;
        }

        if (action.kind === 'steal') {
            setDraft({
                kind: 'steal',
                targetPlayerId: action.targetPlayerId,
            });
            setScenePrimedAction(action);
        }
    };

    const toggleAmbient = () => {
        if (isAmbientSoundPlaying()) {
            stopAmbientSound();
            setAmbientEnabled(false);
            return;
        }

        setAmbientEnabled(startAmbientSound());
    };

    return (
        <main className="app-root">
            <RelicScene
                snapshot={game.snapshot}
                localPlayerId={game.session?.sessionId}
                selectedRoomId={selectedRoomId}
                primedAction={scenePrimedAction}
                focusRoomId={eventFocusRoomId}
                onSelectRoom={setSelectedRoomId}
                onPrimeAction={primeSceneAction}
            />
            {game.snapshot && (
                <TurnFeedbackOverlay
                    snapshot={game.snapshot}
                    localPlayerId={game.session?.sessionId}
                    revealedEvents={revealedEvents}
                />
            )}

            <section className="topbar">
                <div className="brand">
                    <span className="brand-mark"/>
                    <div>
                        <h1>Relic Hunters</h1>
                        <p>{phaseLabel(game.snapshot?.phase ?? game.connectionState)}</p>
                    </div>
                </div>
                <div className="status-row">
                    {game.snapshot
                        ? <RoundStatus round={game.snapshot.round} maxRounds={game.snapshot.maxRounds}/>
                        : <Status label="Round" value="-"/>
                    }
                    <Status label="Hunters" value={String(game.snapshot?.players.length ?? 0)}/>
                    <Status label="Submitted" value={String(game.snapshot?.submittedPlayerIds.length ?? 0)}/>
                    <RelicProgressPill relics={game.snapshot?.relics}/>
                    <WinLeader snapshot={game.snapshot}/>
                    <button
                        type="button"
                        className="help-toggle"
                        aria-label="Keyboard shortcuts"
                        onClick={() => setShowHelpOverlay((v) => !v)}
                    >?</button>
                </div>
            </section>

            <section className={`side-panel${sidePanelCollapsed ? ' collapsed' : ''}`}>
                <button
                    type="button"
                    className="side-panel-toggle"
                    onClick={() => setSidePanelCollapsed((v) => !v)}
                    title={sidePanelCollapsed ? 'Expand panel' : 'Collapse panel'}
                >
                    {sidePanelCollapsed ? '▶ Panel' : '◀ Collapse'}
                </button>
                {!game.session || game.connectionState === 'signed-out'
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
                                {authMode === 'login' ? 'Enter' : 'Create Hunter'}
                            </button>
                        </form>
                    )
                    : (
                        <div className="panel stack">
                            <div className="profile-row">
                                <span
                                    className="hunter-dot"
                                    style={{
                                        background: colorForId(game.session.sessionId),
                                    }}
                                />
                                <div>
                                    <strong>{game.session.username}</strong>
                                    <span>{shortId(game.session.sessionId)}</span>
                                </div>
                            </div>

                            <div className="button-grid">
                                <button type="button" onClick={game.createRoom}>New Room</button>
                                <button type="button" onClick={game.refreshRooms}>Refresh</button>
                                <button type="button" onClick={game.logout}>Logout</button>
                                <button
                                    type="button"
                                    className={ambientEnabled ? 'active' : ''}
                                    onClick={toggleAmbient}
                                >
                                    Atmosphere
                                </button>
                            </div>

                            <div className="room-list">
                                {rooms.map((room) => (
                                    <button
                                        type="button"
                                        key={room.roomId}
                                        className={room.roomId === game.roomId
                                            ? 'room-row active'
                                            : 'room-row'}
                                        onClick={() => game.joinRoom(room.roomId)}
                                    >
                                        <span>{room.name}</span>
                                        <small>{room.onlineMemberCount} online</small>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                {game.session && game.roomId && (
                    <div className="panel stack">
                        <CharacterSelect
                            currentPlayer={currentPlayer}
                            selectedCharacterId={selectedCharacterId}
                            onSelect={(characterId) => {
                                playUiSound('select');
                                setSelectedCharacterId(characterId);
                            }}
                            phase={game.snapshot?.phase}
                        />

                        <div className="objective-card">
                            <span>Final Goal</span>
                            <strong>Collect relic points, reach the Exit, then submit Escape before the ruin closes.</strong>
                            <small>Highest safe score claims the Heart Relic.</small>
                        </div>

                        <div className="objective-card objective-card-next">
                            <span>Current Goal</span>
                            <strong>{objective}</strong>
                            {currentPlayer && (
                                <small>
                                    {selectedCharacter.role} / {currentPlayer.health} health / {currentPlayer.score} score / {currentPlayer.relicIds.length} relics
                                </small>
                            )}
                        </div>

                        <div className="button-grid">
                            <button type="button" onClick={joinExpedition}>
                                {currentPlayer ? 'Update Hunter' : `Join as ${selectedCharacter.name}`}
                            </button>
                            <button type="button" onClick={startExpedition}>
                                Start
                            </button>
                            <button type="button" onClick={resetExpedition}>
                                Reset
                            </button>
                            <button
                                type="button"
                                className={ambientEnabled ? 'active' : ''}
                                onClick={toggleAmbient}
                            >
                                Atmosphere
                            </button>
                        </div>

                        {game.snapshot && game.snapshot.phase === 'lobby' && (
                            <LobbyPartyPanel
                                snapshot={game.snapshot}
                                localPlayerId={game.session.sessionId}
                            />
                        )}

                        {isLocked && lockedAction
                            ? (
                                <LockedPlanCard
                                    action={lockedAction}
                                    snapshot={game.snapshot}
                                    localPlayerId={game.session.sessionId}
                                />
                            )
                            : (
                            <>

                        <div className="action-picker">
                            {(['move', 'search', 'steal', 'escape'] as const).map((kind) => {
                                const cq = actionConsequence(
                                    kind, game.snapshot, currentRoom,
                                    moveTargets, stealTargets, currentPlayer,
                                );
                                const isEscapeUrgent = kind === 'escape' &&
                                    currentRoom?.kind === 'exit' &&
                                    (currentPlayer?.relicIds.length ?? 0) > 0;
                                return (
                                    <button
                                        type="button"
                                        key={kind}
                                        className={[
                                            draft.kind === kind ? 'active' : '',
                                            isEscapeUrgent ? 'action-escape-urgent' : '',
                                        ].filter(Boolean).join(' ')}
                                        onClick={() => {
                                            playUiSound('select');
                                            const nextDraft: ActionDraft = kind === 'move'
                                                ? {
                                                    kind,
                                                    targetRoomId: selectedRoomId &&
                                                            moveTargets.includes(selectedRoomId)
                                                        ? selectedRoomId
                                                        : moveTargets[0],
                                                }
                                                : kind === 'steal'
                                                ? {
                                                    kind,
                                                    targetPlayerId: stealTargets[0]?.playerId,
                                                }
                                                : { kind };
                                            setDraft(nextDraft);
                                            setScenePrimedAction(nextDraft);
                                        }}
                                    >
                                        <span>
                                            {ACTION_INFO[kind].label}
                                            <kbd className="action-key">{(['move','search','steal','escape'] as const).indexOf(kind) + 1}</kbd>
                                        </span>
                                        <small>{ACTION_INFO[kind].noise}</small>
                                        <em className={`action-cq action-cq-${cq.status}`}>{cq.text}</em>
                                    </button>
                                );
                            })}
                        </div>

                        <div className="action-brief">
                            <strong>{actionInfo.label}</strong>
                            <span>{actionInfo.description}</span>
                            {submitBlocker && <small>{submitBlocker}</small>}
                            {partyCoordination && <small>{partyCoordination.actionHint}</small>}
                            {(() => {
                                const inv = game.snapshot?.roomInvestigations?.find(
                                    (i) => i.roomId === currentRoom?.id,
                                );
                                return inv?.danger && draft.kind === 'search'
                                    ? <small className="action-brief-danger">! {inv.danger}</small>
                                    : null;
                            })()}
                        </div>

                        {draft.kind === 'move' && (
                            <select
                                value={draft.targetRoomId ?? selectedRoomId ?? moveTargets[0] ?? ''}
                                onChange={(event) =>
                                    {
                                        const nextDraft = {
                                            kind: 'move' as const,
                                            targetRoomId: event.target.value,
                                        };
                                        setDraft(nextDraft);
                                        setScenePrimedAction(nextDraft);
                                    }}
                            >
                                {moveTargets.map((roomId) => {
                                    const room = game.snapshot?.map.find((r) => r.id === roomId);
                                    const dist = exitDistances.get(roomId);
                                    const hasRelic = game.snapshot?.relics.some(
                                        (r) => r.roomId === roomId && !r.foundBy && !r.carriedBy && !r.escapedBy,
                                    );
                                    const parts = [roomName(game.snapshot, roomId)];
                                    if (room?.kind && room.kind !== 'hallway' && room.kind !== 'entrance') parts.push(`[${room.kind}]`);
                                    if (dist !== undefined) parts.push(`${dist}→exit`);
                                    if (hasRelic) parts.push('◆ relic');
                                    return (
                                        <option key={roomId} value={roomId}>
                                            {parts.join(' · ')}
                                        </option>
                                    );
                                })}
                            </select>
                        )}

                        {draft.kind === 'steal' && (
                            <select
                                value={draft.targetPlayerId ?? stealTargets[0]?.playerId ?? ''}
                                onChange={(event) =>
                                    {
                                        const nextDraft = {
                                            kind: 'steal' as const,
                                            targetPlayerId: event.target.value,
                                        };
                                        setDraft(nextDraft);
                                        setScenePrimedAction(nextDraft);
                                    }}
                            >
                                {stealTargets.map((player) => (
                                    <option key={player.playerId} value={player.playerId}>
                                        {player.username}
                                    </option>
                                ))}
                            </select>
                        )}

                            </>
                            )}

                        {roundNoiseCount > 0 && (
                            <div className={`noise-meter ${roundNoiseCount >= 3 ? 'noise-high' : roundNoiseCount >= 2 ? 'noise-medium' : 'noise-low'}`}>
                                <span>Last round noise</span>
                                <span className="noise-pips">
                                    {Array.from({ length: Math.min(5, roundNoiseCount) }, (_, i) => (
                                        <span key={i} className="noise-pip"/>
                                    ))}
                                </span>
                                <small>{roundNoiseCount >= 3 ? 'Rooms destabilising' : 'Some disruption'}</small>
                            </div>
                        )}

                        {game.snapshot && game.snapshot.maxRounds - game.snapshot.round <= 1 && (
                            <div className={`round-warning ${game.snapshot.round >= game.snapshot.maxRounds ? 'round-warning-final' : ''}`}>
                                {game.snapshot.round >= game.snapshot.maxRounds
                                    ? 'Final round — escape or be lost to the ruin.'
                                    : `${game.snapshot.maxRounds - game.snapshot.round} round${game.snapshot.maxRounds - game.snapshot.round === 1 ? '' : 's'} remaining — the ruin closes soon.`}
                            </div>
                        )}

                        <button
                            type="button"
                            className="primary"
                            disabled={!canSubmit}
                            onClick={submitAction}
                        >
                            {game.snapshot?.submittedPlayerIds.includes(game.session.sessionId)
                                ? 'Plan Locked'
                                : <>Submit Plan <kbd className="action-key action-key-enter">↵</kbd></>}
                        </button>
                    </div>
                )}

                {game.session && game.roomId && game.snapshot && (
                    <EscapeDecisionPanel
                        snapshot={game.snapshot}
                        localPlayerId={game.session.sessionId}
                    />
                )}

                {game.session && game.roomId && (
                    <PersonalRoundCard
                        events={revealedEvents}
                        localPlayerId={game.session.sessionId}
                    />
                )}

                {game.session && game.roomId && game.snapshot && partyCoordination && (
                    <PartyCoordinationPanel
                        snapshot={game.snapshot}
                        localPlayerId={game.session.sessionId}
                        summary={partyCoordination}
                    />
                )}

                {game.session && game.roomId && game.snapshot && (
                    <CastleMap
                        snapshot={game.snapshot}
                        localPlayerId={game.session.sessionId}
                        selectedRoomId={selectedRoomId}
                        lastEvent={lastEvent}
                        onSelectRoom={setSelectedRoomId}
                    />
                )}

                {game.session && game.roomId && game.snapshot && selectedRoomId && (
                    <RoomDetailCard
                        snapshot={game.snapshot}
                        roomId={selectedRoomId}
                        localPlayerId={game.session.sessionId}
                        exitDistances={exitDistances}
                        onPrimeMove={(targetRoomId) => {
                            const next = { kind: 'move' as const, targetRoomId };
                            setDraft(next);
                            setScenePrimedAction(next);
                        }}
                        onDismiss={() => setSelectedRoomId(undefined)}
                    />
                )}

                {game.session && game.roomId && game.snapshot && (
                    <ClueJournal
                        snapshot={game.snapshot}
                        onSelectRoom={setSelectedRoomId}
                    />
                )}

                {showPartyChangePrompt && game.snapshot && currentRoomSummary && (
                    <PartyChangePrompt
                        expeditionPlayers={game.snapshot.players.length}
                        onlinePlayers={currentRoomSummary.onlineMemberCount}
                        onReset={resetExpedition}
                        onContinue={() => setDismissedPartyChangeKey(partyChangeKey)}
                    />
                )}

                {game.session && game.roomId && (
                    <RoomIntel
                        currentRoom={currentRoom}
                        moveTargets={moveTargets}
                        snapshot={game.snapshot}
                    />
                )}

                {game.error && <div className="panel error-panel">{game.error}</div>}
            </section>

            <section className="bottom-panel">
                <HunterList
                    players={game.snapshot?.players ?? []}
                    localPlayerId={game.session?.sessionId}
                    phase={game.snapshot?.phase}
                    submittedPlayerIds={game.snapshot?.submittedPlayerIds ?? []}
                />
                <TurnDiffStrip events={revealedEvents}/>
                <RoundChronicle
                    events={revealedEvents}
                    phase={game.snapshot?.phase}
                    lastEvent={lastEvent}
                    localPlayerId={game.session?.sessionId}
                />
            </section>

            {personalFlash && (
                <div
                    key={personalFlash.key}
                    className={`personal-event-flash flash-${personalFlash.tone}`}
                    onAnimationEnd={() => setPersonalFlash(null)}
                    aria-hidden="true"
                />
            )}

            {currentPlayer && currentPlayer.health === 1 && !currentPlayer.escaped && !currentPlayer.defeated && (
                <div className="low-health-banner" role="alert">
                    One hit from defeat — move carefully.
                </div>
            )}

            {showHelpOverlay && (
                <div
                    className="help-overlay"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Keyboard shortcuts"
                    onClick={() => setShowHelpOverlay(false)}
                >
                    <div className="help-card" onClick={(e) => e.stopPropagation()}>
                        <span className="panel-label">Controls</span>
                        <div className="help-grid">
                            <kbd>WASD</kbd><span>Move in 3D scene</span>
                            <kbd>Mouse</kbd><span>Look around</span>
                            <kbd>1 – 4</kbd><span>Select action (Move/Search/Steal/Escape)</span>
                            <kbd>↵</kbd><span>Submit plan</span>
                            <kbd>? / F1</kbd><span>Toggle this help</span>
                            <kbd>Esc</kbd><span>Close overlays</span>
                        </div>
                        <button type="button" className="primary" onClick={() => setShowHelpOverlay(false)}>
                            Close
                        </button>
                    </div>
                </div>
            )}

            {currentPlayer?.defeated && game.snapshot?.phase === 'planning' && (
                <div className="defeated-overlay" aria-live="polite">
                    <div className="defeated-card">
                        <span className="panel-label">Fallen</span>
                        <strong>You are down</strong>
                        <p>The castle keeps your relics. Watch the others — the expedition may still turn.</p>
                        <small>Your score: {currentPlayer.score} pts</small>
                    </div>
                </div>
            )}

            {showTensionBeat && (
                <div className="tension-beat" aria-live="assertive" role="status">
                    <span>The castle answers…</span>
                </div>
            )}

            {showDigest && (
                <PostRoundDigest events={digestEvents} onDismiss={() => setShowDigest(false)}/>
            )}

            {game.snapshot?.phase === 'finished' && (
                <VictoryPanel snapshot={game.snapshot}/>
            )}

            {showOnboarding &&
                game.snapshot?.phase === 'planning' &&
                game.snapshot.round === 1 && (
                <OnboardingOverlay onDismiss={() => {
                    localStorage.setItem('relic-onboarding-v1', '1');
                    setShowOnboarding(false);
                }}/>
            )}

            {game.snapshot && game.snapshot.phase !== 'lobby' && (
                <div className="scene-crosshair" aria-hidden="true">
                    <div className="scene-crosshair-dot"/>
                </div>
            )}

            {game.snapshot && (
                <SceneMinimapOverlay
                    snapshot={game.snapshot}
                    localPlayerId={game.session?.sessionId}
                />
            )}

            {phaseBanner && (
                <div className="phase-banner" role="status" aria-live="assertive" aria-atomic="true">
                    {phaseBanner}
                </div>
            )}

            {roomEntryFlash && (
                <div
                    key={roomEntryFlash.key}
                    className="room-entry-flash"
                    onAnimationEnd={() => setRoomEntryFlash(null)}
                    aria-live="polite"
                    aria-atomic="true"
                >
                    {roomEntryFlash.room}
                </div>
            )}
        </main>
    );
}

const ACTION_INFO: Record<
    RelicActionKind,
    Readonly<{ label: string; noise: string; description: string }>
> = {
    move: {
        label: 'Move',
        noise: 'quiet',
        description: 'Step into an adjacent room to reach relics or race toward the exit.',
    },
    search: {
        label: 'Search',
        noise: 'noisy',
        description: 'Look for relics in this room. Searching creates danger but wins games.',
    },
    steal: {
        label: 'Steal',
        noise: 'loud',
        description: 'Take a relic from another hunter in your room. Failed attempts still make noise.',
    },
    escape: {
        label: 'Escape',
        noise: 'silent',
        description: 'Leave from the Exit with your relics. Escaped hunters keep their score safe.',
    },
};

function CharacterSelect({
    currentPlayer,
    selectedCharacterId,
    onSelect,
    phase,
}: Readonly<{
    currentPlayer?: RelicPlayer;
    selectedCharacterId: RelicCharacterId;
    onSelect(characterId: RelicCharacterId): void;
    phase?: RelicPublicSnapshot['phase'];
}>) {
    const locked = !!currentPlayer && phase !== 'lobby';
    const activeCharacter = findRelicCharacter(
        locked ? currentPlayer.characterId : selectedCharacterId,
    );

    return (
        <div className="character-panel">
            <div className="character-current">
                <span
                    className="character-sigil"
                    style={{
                        background: activeCharacter.colors.accent,
                        boxShadow: `0 0 24px ${activeCharacter.colors.accent}55`,
                    }}
                />
                <div>
                    <span className="panel-label">
                        {locked ? 'Your Hunter' : 'Choose Hunter'}
                    </span>
                    <strong>{activeCharacter.name}</strong>
                    <small>{activeCharacter.epithet}</small>
                </div>
            </div>

            <div className="character-grid">
                {RELIC_CHARACTERS.map((character) => (
                    <button
                        type="button"
                        className={character.id === activeCharacter.id ? 'character-card active' : 'character-card'}
                        key={character.id}
                        disabled={locked}
                        onClick={() => onSelect(character.id)}
                        style={{
                            borderColor: character.id === activeCharacter.id
                                ? `${character.colors.accent}cc`
                                : undefined,
                        }}
                    >
                        <span
                            className="character-swatch"
                            style={{
                                background: `linear-gradient(135deg, ${character.colors.primary}, ${character.colors.secondary})`,
                            }}
                        />
                        <strong>{character.name}</strong>
                        <small>{character.role}</small>
                    </button>
                ))}
            </div>

            <div className="character-skill">
                <span>{activeCharacter.passive}</span>
                <small>{activeCharacter.skillset.join(' / ')}</small>
            </div>
        </div>
    );
}

function LobbyPartyPanel({
    snapshot,
    localPlayerId,
}: Readonly<{ snapshot: RelicPublicSnapshot; localPlayerId?: string }>) {
    if (snapshot.phase !== 'lobby' || snapshot.players.length === 0) return null;
    return (
        <div className="panel lobby-party-panel">
            <span className="panel-label">Party</span>
            <div className="lobby-party-list">
                {snapshot.players.map((player) => {
                    const char = findRelicCharacter(player.characterId);
                    const isLocal = player.playerId === localPlayerId;
                    return (
                        <div key={player.playerId} className={`lobby-party-row${isLocal ? ' local' : ''}`}>
                            <span
                                className="lobby-party-swatch"
                                style={{ background: char.colors.accent }}
                            />
                            <span className="lobby-party-name">{player.username}</span>
                            <span className="lobby-party-char">{char.name}</span>
                            {isLocal && <span className="lobby-party-you">you</span>}
                        </div>
                    );
                })}
            </div>
            {snapshot.players.length < 2 && (
                <small className="lobby-party-hint">Waiting for at least one more hunter…</small>
            )}
        </div>
    );
}

function PartyChangePrompt({
    expeditionPlayers,
    onlinePlayers,
    onReset,
    onContinue,
}: Readonly<{
    expeditionPlayers: number;
    onlinePlayers: number;
    onReset(): void;
    onContinue(): void;
}>) {
    return (
        <div className="panel stack party-change-panel">
            <div>
                <span className="panel-label">Party Changed</span>
                <strong>{onlinePlayers}/{expeditionPlayers} hunters are online</strong>
            </div>
            <p>The expedition roster no longer matches the connected party.</p>
            <div className="button-grid">
                <button type="button" className="primary" onClick={onReset}>
                    Start Over
                </button>
                <button type="button" onClick={onContinue}>
                    Keep Going
                </button>
            </div>
        </div>
    );
}

function RoomIntel({
    currentRoom,
    moveTargets,
    snapshot,
}: Readonly<{
    currentRoom?: RelicPublicSnapshot['map'][number];
    moveTargets: readonly string[];
    snapshot?: RelicPublicSnapshot;
}>) {
    const [open, setOpen] = useState(false);
    const roomRelics = currentRoom && snapshot
        ? snapshot.relics.filter((relic) =>
            relic.roomId === currentRoom.id && !relic.carriedBy && !relic.escapedBy
        )
        : [];
    const investigation = currentRoom && snapshot
        ? snapshot.roomInvestigations?.find((candidate) =>
            candidate.roomId === currentRoom.id
        )
        : undefined;
    const revealedRoom = investigation?.revealedRoomId && snapshot
        ? snapshot.map.find((room) => room.id === investigation.revealedRoomId)
        : undefined;

    return (
        <div className="panel stack room-intel">
            <button type="button" className="collapsible-header" onClick={() => setOpen((v) => !v)}>
                <div>
                    <span className="panel-label">Current Room</span>
                    <strong>{currentRoom?.name ?? 'No hunter in the ruin'}</strong>
                </div>
                <span className="collapse-chevron">{open ? '▲' : '▼'}</span>
            </button>
            {open && currentRoom && (
                <>
                    <div className="tag-row">
                        <span className={`tag ${currentRoom.unstable ? 'danger' : ''}`}>
                            {currentRoom.unstable ? 'unstable' : 'stable'}
                        </span>
                        <span className={`tag ${currentRoom.collapsed ? 'danger' : ''}`}>
                            {currentRoom.collapsed ? 'collapsed' : currentRoom.kind}
                        </span>
                    </div>
                    <div className="intel-grid">
                        <div>
                            <span>Paths</span>
                            <strong>{moveTargets.length > 0
                                ? moveTargets.map((roomId) => roomName(snapshot, roomId)).join(', ')
                                : 'none'}</strong>
                        </div>
                        <div>
                            <span>Relic Signal</span>
                            <strong>{roomRelics.length > 0
                                ? roomRelics.map((relic) => relic.name).join(', ')
                                : investigation
                                ? investigation.result === 'relic-found'
                                    ? 'relic trail marked'
                                    : 'searched clear'
                                : 'quiet stone'}</strong>
                        </div>
                        <div>
                            <span>Investigation</span>
                            <strong>{investigation
                                ? investigation.summary
                                : 'unmarked'}</strong>
                        </div>
                        {investigation && (
                            <div>
                                <span>Clue Note</span>
                                <strong>{investigation.danger ?? investigation.hint}</strong>
                            </div>
                        )}
                        {revealedRoom && (
                            <div>
                                <span>Clue Target</span>
                                <strong>{revealedRoom.name}</strong>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

export type PartyCoordinationSummary = Readonly<{
    currentRoomId: string;
    currentRoomName: string;
    hereCount: number;
    elsewhereCount: number;
    activeCount: number;
    submittedCount: number;
    splitLabel: string;
    readinessLabel: string;
    actionHint: string;
    roomOccupants: readonly RelicPlayer[];
    stealTargets: readonly RelicPlayer[];
    relicCarrierCount: number;
}>;

export function derivePartyCoordination(
    snapshot: RelicPublicSnapshot | undefined,
    localPlayerId: string | undefined,
    actionKind: RelicActionKind = 'move',
): PartyCoordinationSummary | undefined {
    const activePlayers = snapshot?.players.filter((player) =>
        !player.escaped && !player.defeated
    ) ?? [];
    const localPlayer = activePlayers.find((player) => player.playerId === localPlayerId);
    const currentRoom = snapshot?.map.find((room) => room.id === localPlayer?.roomId);
    if (!snapshot || !localPlayer || !currentRoom) {
        return undefined;
    }

    const roomOccupants = activePlayers.filter((player) => player.roomId === currentRoom.id);
    const stealTargets = roomOccupants.filter((player) => player.playerId !== localPlayer.playerId);
    const relicCarrierCount = stealTargets.filter((player) => player.relicIds.length > 0).length;
    const submittedCount = activePlayers.filter((player) =>
        snapshot.submittedPlayerIds.includes(player.playerId)
    ).length;
    const hereCount = roomOccupants.length;
    const elsewhereCount = Math.max(0, activePlayers.length - hereCount);

    return {
        currentRoomId: currentRoom.id,
        currentRoomName: currentRoom.name,
        hereCount,
        elsewhereCount,
        activeCount: activePlayers.length,
        submittedCount,
        splitLabel: `${hereCount} ${plural('hunter', hereCount)} here / ${elsewhereCount} elsewhere`,
        readinessLabel: `${submittedCount}/${activePlayers.length} plans locked`,
        actionHint: partyActionHint({
            actionKind,
            currentRoom,
            hereCount,
            elsewhereCount,
            stealTargets,
            relicCarrierCount,
        }),
        roomOccupants,
        stealTargets,
        relicCarrierCount,
    };
}

function PartyCoordinationPanel({
    snapshot,
    localPlayerId,
    summary,
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    localPlayerId?: string;
    summary: PartyCoordinationSummary;
}>) {
    return (
        <div className="panel stack party-coordination" aria-label="Room occupants">
            <div>
                <span className="panel-label">Party Coordination</span>
                <strong>{summary.splitLabel}</strong>
                <small>{summary.readinessLabel}</small>
            </div>
            <div className="coordination-grid">
                <div>
                    <span>Room</span>
                    <strong>{summary.currentRoomName}</strong>
                </div>
                <div>
                    <span>Steal Risk</span>
                    <strong>{summary.relicCarrierCount > 0
                        ? `${summary.relicCarrierCount} relic carrier${summary.relicCarrierCount === 1 ? '' : 's'} here`
                        : 'no relic carrier here'}</strong>
                </div>
            </div>
            <small className="coordination-hint">{summary.actionHint}</small>
            <div className="occupant-list">
                {summary.roomOccupants.map((player) => (
                    <OccupantRow
                        key={player.playerId}
                        player={player}
                        local={player.playerId === localPlayerId}
                        submitted={snapshot.submittedPlayerIds.includes(player.playerId)}
                    />
                ))}
            </div>
        </div>
    );
}

function OccupantRow({
    player,
    local,
    submitted,
}: Readonly<{
    player: RelicPlayer;
    local: boolean;
    submitted: boolean;
}>) {
    const character = findRelicCharacter(player.characterId);
    return (
        <div className={local ? 'occupant-row local' : 'occupant-row'}>
            <span
                className="hunter-dot"
                style={{ background: character.colors.accent }}
            />
            <div>
                <strong>{player.username}{local ? ' (you)' : ''}</strong>
                <small>{character.role} / {player.health} health / {player.relicIds.length} relic{player.relicIds.length === 1 ? '' : 's'} / {player.score} score</small>
            </div>
            <em>{submitted ? 'submitted' : 'choosing'}</em>
        </div>
    );
}

function ClueJournal({
    snapshot,
    onSelectRoom,
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    onSelectRoom(roomId: string): void;
}>) {
    const [open, setOpen] = useState(true);
    const investigations = [...(snapshot.roomInvestigations ?? [])]
        .sort((left, right) => right.searchedAtRound - left.searchedAtRound);

    if (investigations.length === 0) {
        return null;
    }

    return (
        <div className="panel stack clue-journal" aria-label="Discovered clue trails">
            <button type="button" className="collapsible-header" onClick={() => setOpen((v) => !v)}>
                <div>
                    <span className="panel-label">Discovered Trails</span>
                    <strong>{investigations.length} marked clue{investigations.length === 1 ? '' : 's'}</strong>
                </div>
                <span className="collapse-chevron">{open ? '▲' : '▼'}</span>
            </button>
            {open && (
                <div className="clue-journal-list">
                    {investigations.map((investigation) => {
                        const room = snapshot.map.find((candidate) =>
                            candidate.id === investigation.roomId
                        );
                        const target = investigation.revealedRoomId
                            ? snapshot.map.find((candidate) =>
                                candidate.id === investigation.revealedRoomId
                            )
                            : undefined;
                        return (
                            <button
                                type="button"
                                key={`${investigation.roomId}-${investigation.searchedAtRound}`}
                                className={`clue-journal-entry${target ? ' has-target' : ''}`}
                                onClick={() => onSelectRoom(target?.id ?? investigation.roomId)}
                            >
                                <span>
                                    Round {investigation.searchedAtRound} · {investigation.searchedByUsername}
                                </span>
                                <strong>
                                    {room?.name ?? investigation.roomId}
                                    {target ? ` → ${target.name}` : ' — no target'}
                                </strong>
                                <small>{investigation.summary}</small>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

type TurnFeedbackStage = 'plans-locked' | 'revealing' | 'resolved' | 'warning' | 'finished';

type TurnFeedback = Readonly<{
    stage: TurnFeedbackStage;
    eyebrow: string;
    title: string;
    detail: string;
    events: readonly RelicEvent[];
}>;

function TurnFeedbackOverlay({
    snapshot,
    localPlayerId,
    revealedEvents,
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    localPlayerId?: string;
    revealedEvents: readonly RelicEvent[];
}>) {
    const feedback = deriveTurnFeedback(snapshot, localPlayerId, revealedEvents);
    if (!feedback) {
        return null;
    }

    return (
        <section
            className={`turn-feedback turn-feedback-${feedback.stage}`}
            aria-label="Turn resolution feedback"
        >
            <span>{feedback.eyebrow}</span>
            <strong>{feedback.title}</strong>
            <small>{feedback.detail}</small>
            {feedback.events.length > 0 && (
                <div className="turn-feedback-events">
                    {feedback.events.map((event) => {
                        const narLine = narratorLine(event);
                        const personal = isPersonalEvent(event, localPlayerId);
                        return (
                            <div
                                className={`turn-event-card ${toneClass(event)} ${personal ? 'personal' : ''}`}
                                key={event.id}
                            >
                                {narLine && <em className="narrator-voice">{narLine}</em>}
                                <span>{event.message}</span>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}

function deriveTurnFeedback(
    snapshot: RelicPublicSnapshot,
    localPlayerId: string | undefined,
    events: readonly RelicEvent[],
): TurnFeedback | undefined {
    const active = snapshot.players.filter((player) => !player.escaped && !player.defeated);
    const submittedCount = snapshot.submittedPlayerIds.length;
    const waitingCount = Math.max(0, active.length - submittedCount);
    const localSubmitted = !!localPlayerId && snapshot.submittedPlayerIds.includes(localPlayerId);

    if (
        snapshot.phase === 'planning' &&
        submittedCount > 0 &&
        waitingCount > 0
    ) {
        return {
            stage: 'plans-locked',
            eyebrow: localSubmitted ? 'Plans Locked' : 'Planning',
            title: localSubmitted ? 'Your plan is locked' : 'Hunters are choosing',
            detail: `Waiting for ${waitingCount} hunter${waitingCount === 1 ? '' : 's'} to lock a plan.`,
            events: [],
        };
    }

    const lastTurnEvent = [...events].reverse().find(isTurnFeedbackEvent);
    if (!lastTurnEvent) {
        return undefined;
    }

    const resultEvents = events
        .filter(isTurnResultEvent)
        .slice(-4)
        .reverse();
    const latestEvents = resultEvents.length > 0 ? resultEvents : [lastTurnEvent];

    if (snapshot.phase === 'finished' || lastTurnEvent.type === 'game_finished') {
        return {
            stage: 'finished',
            eyebrow: 'Expedition End',
            title: 'The ruin is quiet',
            detail: lastTurnEvent.message,
            events: latestEvents,
        };
    }

    if (lastTurnEvent.type === 'action_revealed') {
        return {
            stage: 'revealing',
            eyebrow: 'Revealing Actions',
            title: `Round ${lastTurnEvent.round} plans are revealed`,
            detail: 'Watch the room, map, and chronicle as each plan resolves.',
            events: [lastTurnEvent],
        };
    }

    if (lastTurnEvent.type === 'round_started' && lastTurnEvent.message.includes('begins')) {
        return {
            stage: 'resolved',
            eyebrow: 'Round Resolved',
            title: `Round ${snapshot.round} begins`,
            detail: lastTurnEvent.message,
            events: latestEvents,
        };
    }

    if (lastTurnEvent.type === 'round_started') {
        return undefined;
    }

    if (lastTurnEvent.tone === 'danger') {
        return {
            stage: 'warning',
            eyebrow: 'Castle Reaction',
            title: turnEventHeadline(lastTurnEvent),
            detail: lastTurnEvent.message,
            events: latestEvents,
        };
    }

    return {
        stage: 'resolved',
        eyebrow: 'Action Result',
        title: turnEventHeadline(lastTurnEvent),
        detail: lastTurnEvent.message,
        events: latestEvents,
    };
}

function isTurnFeedbackEvent(event: RelicEvent): boolean {
    return event.type !== 'game_waiting' &&
        event.type !== 'player_joined' &&
        event.type !== 'action_submitted';
}

function isTurnResultEvent(event: RelicEvent): boolean {
    switch (event.type) {
        case 'player_moved':
        case 'player_searched':
        case 'relic_found':
        case 'steal_succeeded':
        case 'steal_failed':
        case 'escape_failed':
        case 'player_escaped':
        case 'noise_pulse':
        case 'player_damaged':
        case 'room_unstable':
        case 'room_collapsed':
            return true;
        default:
            return false;
    }
}

function turnEventHeadline(event: RelicEvent): string {
    switch (event.type) {
        case 'player_moved':
            return 'A hunter slips through the dark';
        case 'player_searched':
            return 'Desperate hands search the room';
        case 'relic_found':
            return 'Ancient gold catches the light';
        case 'steal_succeeded':
            return 'A relic changes hands in shadow';
        case 'steal_failed':
            return 'A theft attempt comes up empty';
        case 'escape_failed':
            return 'The castle refuses to release';
        case 'player_escaped':
            return 'A hunter breaks for daylight';
        case 'noise_pulse':
            return 'The ruin stirs with the sound';
        case 'player_damaged':
            return 'Stone and shadow take their toll';
        case 'room_unstable':
            return 'A room begins to crack and groan';
        case 'room_collapsed':
            return 'A chamber surrenders to ruin';
        default:
            return event.message;
    }
}

type ConsequenceStatus = 'ok' | 'warn' | 'block';
type ActionConsequence = Readonly<{ text: string; status: ConsequenceStatus }>;

function actionConsequence(
    kind: RelicActionKind,
    snapshot: RelicPublicSnapshot | undefined,
    currentRoom: RelicPublicSnapshot['map'][number] | undefined,
    moveTargets: readonly string[],
    stealTargets: readonly RelicPlayer[],
    currentPlayer: RelicPlayer | undefined,
): ActionConsequence {
    if (!snapshot || !currentPlayer) return { text: '—', status: 'ok' };
    switch (kind) {
        case 'move':
            return moveTargets.length > 0
                ? { text: `${moveTargets.length} path${moveTargets.length === 1 ? '' : 's'} open`, status: 'ok' }
                : { text: 'all paths blocked', status: 'block' };
        case 'search': {
            const searched = snapshot.roomInvestigations?.some(
                (inv) => inv.roomId === currentPlayer.roomId,
            );
            return searched
                ? { text: 'already searched here', status: 'warn' }
                : { text: 'room not yet searched', status: 'ok' };
        }
        case 'steal':
            return stealTargets.length > 0
                ? { text: `${stealTargets.length} hunter${stealTargets.length === 1 ? '' : 's'} here`, status: 'ok' }
                : { text: 'no targets here', status: 'block' };
        case 'escape':
            return currentRoom?.kind === 'exit'
                ? { text: 'exit door in reach', status: 'ok' }
                : { text: 'not at exit room', status: 'block' };
    }
}

type CastleMapBounds = Readonly<{
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}>;

function CastleMap({
    snapshot,
    localPlayerId,
    selectedRoomId,
    lastEvent,
    onSelectRoom,
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    localPlayerId?: string;
    selectedRoomId?: string;
    lastEvent?: RelicEvent;
    onSelectRoom(roomId: string): void;
}>) {
    const bounds = castleMapBounds(snapshot.map);
    const exitDistances = castleMapExitDistances(snapshot.map);
    const localPlayer = snapshot.players.find((p) => p.playerId === localPlayerId);
    const localRoom = localPlayer ? snapshot.map.find((r) => r.id === localPlayer.roomId) : undefined;
    const isActivePlanning = snapshot.phase === 'planning' &&
        !!localPlayer &&
        !localPlayer.escaped &&
        !localPlayer.defeated &&
        !snapshot.submittedPlayerIds.includes(localPlayer.playerId);
    const reachableIds = isActivePlanning
        ? new Set(
            (localRoom?.neighbors ?? []).filter((nId) => {
                const n = snapshot.map.find((r) => r.id === nId);
                return n && !n.collapsed;
            }),
        )
        : new Set<string>();
    const exitPath = localPlayer && localPlayer.relicIds.length > 0 &&
        !localPlayer.escaped && !localPlayer.defeated
        ? castleMapExitPath(snapshot.map, localPlayer.roomId)
        : undefined;
    const clueTargetRoomIds = new Set(
        (snapshot.roomInvestigations ?? [])
            .map((investigation) => investigation.revealedRoomId)
            .filter((roomId): roomId is string => !!roomId),
    );
    const activePlayersByRoom = new Map<string, RelicPlayer[]>();
    for (const player of snapshot.players) {
        if (player.escaped || player.defeated) {
            continue;
        }
        const occupants = activePlayersByRoom.get(player.roomId) ?? [];
        occupants.push(player);
        activePlayersByRoom.set(player.roomId, occupants);
    }
    const edges = snapshot.map.flatMap((room) =>
        room.neighbors
            .filter((neighborId) => room.id < neighborId)
            .map((neighborId) => ({
                from: room,
                to: snapshot.map.find((candidate) => candidate.id === neighborId),
            }))
            .filter((edge): edge is Readonly<{
                from: RelicPublicSnapshot['map'][number];
                to: RelicPublicSnapshot['map'][number];
            }> => !!edge.to)
    );

    const clueTrails = (snapshot.roomInvestigations ?? []).filter(
        (inv) => inv.revealedRoomId,
    );
    const relicRooms = snapshot.relics.filter(
        (r) => !r.carriedBy && !r.escapedBy && r.foundBy && r.roomId,
    );

    return (
        <div className="panel castle-map-panel">
            <div className="castle-map-title">
                <span className="panel-label">Castle Map</span>
                <strong>{snapshot.phase === 'lobby' ? 'Choose a hunter to enter' : 'Track the expedition'}</strong>
            </div>
            <div className="castle-map" aria-label="Castle room map">
                <svg viewBox="0 0 100 100" aria-hidden="true">
                    {edges.map((edge) => {
                        const from = castleMapPoint(edge.from, bounds);
                        const to = castleMapPoint(edge.to, bounds);
                        return (
                            <line
                                key={`${edge.from.id}-${edge.to.id}`}
                                x1={from.x}
                                y1={from.y}
                                x2={to.x}
                                y2={to.y}
                            />
                        );
                    })}
                    {exitPath && exitPath.length > 1 && exitPath.slice(0, -1).map((roomId, i) => {
                        const from = snapshot.map.find((r) => r.id === roomId);
                        const to = snapshot.map.find((r) => r.id === exitPath[i + 1]);
                        if (!from || !to) return null;
                        const fp = castleMapPoint(from, bounds);
                        const tp = castleMapPoint(to, bounds);
                        return (
                            <line
                                key={`exit-route-${roomId}`}
                                className="castle-map-exit-route"
                                x1={fp.x} y1={fp.y}
                                x2={tp.x} y2={tp.y}
                            />
                        );
                    })}
                    {clueTrails.map((inv) => {
                        const from = snapshot.map.find((r) => r.id === inv.roomId);
                        const to = snapshot.map.find((r) => r.id === inv.revealedRoomId);
                        if (!from || !to) return null;
                        const fp = castleMapPoint(from, bounds);
                        const tp = castleMapPoint(to, bounds);
                        return (
                            <line
                                key={`clue-${inv.roomId}-${inv.revealedRoomId}`}
                                className="castle-map-clue-trail"
                                x1={fp.x} y1={fp.y}
                                x2={tp.x} y2={tp.y}
                            />
                        );
                    })}
                    {relicRooms.map((relic) => {
                        const room = snapshot.map.find((r) => r.id === relic.roomId);
                        if (!room) return null;
                        const pt = castleMapPoint(room, bounds);
                        return (
                            <circle
                                key={relic.id}
                                className="castle-map-relic-dot"
                                cx={pt.x} cy={pt.y}
                                r="3.8"
                            />
                        );
                    })}
                </svg>

                {snapshot.map.map((room) => {
                    const point = castleMapPoint(room, bounds);
                    const occupants = activePlayersByRoom.get(room.id) ?? [];
                    const local = snapshot.players.some((player) =>
                        player.playerId === localPlayerId && player.roomId === room.id
                    );
                    const hasOtherHunters = occupants.some((player) =>
                        player.playerId !== localPlayerId
                    );
                    return (
                        <button
                            type="button"
                            key={room.id}
                            className={[
                                'castle-map-room',
                                room.id === selectedRoomId ? 'selected' : '',
                                local ? 'local' : '',
                                reachableIds.has(room.id) ? 'reachable' : '',
                                occupants.length > 0 ? 'occupied' : '',
                                hasOtherHunters ? 'has-others' : '',
                                clueTargetRoomIds.has(room.id) ? 'clue-target' : '',
                                room.unstable ? 'unstable' : '',
                                room.collapsed ? 'collapsed' : '',
                            ].filter(Boolean).join(' ')}
                            style={{
                                left: `${point.x}%`,
                                top: `${point.y}%`,
                                background: roomKindMapColor(room),
                            }}
                            onClick={() => onSelectRoom(room.id)}
                        >
                            <span className="castle-map-room-name">{room.name}</span>
                            {exitDistances.has(room.id) && (
                                <span
                                    className={`castle-map-exit-dist ${room.kind === 'exit' ? 'at-exit' : ''}`}
                                    aria-label={`${exitDistances.get(room.id)} steps from exit`}
                                >
                                    {exitDistances.get(room.id)}
                                </span>
                            )}
                            {occupants.length > 0 && (
                                <span
                                    className="castle-map-occupancy"
                                    aria-label={`${occupants.length} ${plural('hunter', occupants.length)} in ${room.name}`}
                                >
                                    {occupants.length}
                                </span>
                            )}
                            {occupants.length > 0 && (
                                <span className="castle-map-occupant-dots" aria-hidden="true">
                                    {occupants.slice(0, 4).map((player) => (
                                        <span
                                            key={player.playerId}
                                            style={{
                                                background: findRelicCharacter(player.characterId).colors.accent,
                                            }}
                                        />
                                    ))}
                                </span>
                            )}
                        </button>
                    );
                })}

                {snapshot.players.map((player, index) => {
                    const room = snapshot.map.find((candidate) => candidate.id === player.roomId);
                    if (!room || player.escaped || player.defeated) {
                        return null;
                    }

                    const point = castleMapPoint(room, bounds);
                    const offset = castleMapPlayerOffset(index);
                    const character = findRelicCharacter(player.characterId);
                    const recentlyMoved = lastEvent?.type === 'player_moved' &&
                        lastEvent.animationCue?.playerId === player.playerId;
                    return (
                        <span
                            key={player.playerId}
                            className={[
                                'castle-map-hunter',
                                player.playerId === localPlayerId ? 'local' : '',
                                recentlyMoved ? 'recent-move' : '',
                            ].filter(Boolean).join(' ')}
                            style={{
                                left: `${point.x + offset.x}%`,
                                top: `${point.y + offset.y}%`,
                                background: character.colors.accent,
                            }}
                            title={`${player.username}: ${character.name}`}
                        />
                    );
                })}
            </div>
        </div>
    );
}

function RoundChronicle({
    events,
    phase,
    lastEvent,
    localPlayerId,
}: Readonly<{
    events: readonly RelicEvent[];
    phase?: RelicPublicSnapshot['phase'];
    lastEvent?: RelicEvent;
    localPlayerId?: string;
}>) {
    const roundGroups = useMemo(() => {
        const groups = new Map<number, RelicEvent[]>();
        for (const e of events) {
            const list = groups.get(e.round) ?? [];
            list.push(e);
            groups.set(e.round, list);
        }
        return [...groups.entries()]
            .sort((a, b) => b[0] - a[0])
            .slice(0, 3);
    }, [events]);

    return (
        <div className={`chronicle ${toneClass(lastEvent)}`}>
            <div className="chronicle-title">
                <span>{phase === 'finished' ? 'Expedition End' : 'Round Chronicle'}</span>
                <strong>{chronicleHeadline(lastEvent, phase)}</strong>
            </div>
            <div className="chronicle-list chronicle-grouped">
                {roundGroups.map(([round, roundEvents]) => (
                    <div key={round} className="chronicle-round-group">
                        <div className="chronicle-round-header">Round {round}</div>
                        {roundEvents
                            .filter((e) => isTurnResultEvent(e) || e.type === 'action_revealed' || e.type === 'round_started')
                            .slice(-5)
                            .reverse()
                            .map((event) => {
                                const narLine = narratorLine(event);
                                const personal = isPersonalEvent(event, localPlayerId);
                                return (
                                    <div
                                        key={event.id}
                                        className={`chronicle-entry ${toneClass(event)} ${personal ? 'personal' : ''}`}
                                    >
                                        {narLine && <em className="narrator-voice">{narLine}</em>}
                                        <span className="chronicle-message">{event.message}</span>
                                    </div>
                                );
                            })}
                    </div>
                ))}
            </div>
        </div>
    );
}

function OnboardingOverlay({ onDismiss }: Readonly<{ onDismiss(): void }>) {
    return (
        <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-label="How to play">
            <div className="onboarding-card">
                <span className="panel-label">First Expedition</span>
                <h2 className="onboarding-title">The Ruin Awaits</h2>
                <div className="onboarding-steps">
                    <div className="onboarding-step">
                        <div className="onboarding-step-number">I</div>
                        <div>
                            <strong>Plan in secret</strong>
                            <p>Each round, pick one action — Move, Search, Steal, or Escape — without seeing what others chose. Plans are locked simultaneously.</p>
                        </div>
                    </div>
                    <div className="onboarding-step">
                        <div className="onboarding-step-number">II</div>
                        <div>
                            <strong>All revealed at once</strong>
                            <p>When every hunter submits, all plans resolve at the same time. Positions shift, relics change hands, rooms may collapse. Expect chaos.</p>
                        </div>
                    </div>
                    <div className="onboarding-step">
                        <div className="onboarding-step-number">III</div>
                        <div>
                            <strong>Collect and escape</strong>
                            <p>Find relics, reach the Exit room, and submit Escape before the ruin closes. The hunter who escapes with the highest score claims the Heart Relic.</p>
                        </div>
                    </div>
                </div>
                <button type="button" className="primary onboarding-dismiss" onClick={onDismiss}>
                    Into the ruin
                </button>
            </div>
        </div>
    );
}

function PostRoundDigest({
    events,
    onDismiss,
}: Readonly<{
    events: readonly RelicEvent[];
    onDismiss(): void;
}>) {
    const relicsFound = events.filter((e) => e.type === 'relic_found').length;
    const damagedCount = events.filter((e) => e.type === 'player_damaged').length;
    const escapedCount = events.filter((e) => e.type === 'player_escaped').length;
    const collapsedCount = events.filter((e) => e.type === 'room_collapsed').length;
    const stealCount = events.filter((e) => e.type === 'steal_succeeded').length;

    return (
        <div className="digest-overlay" onClick={onDismiss} role="status" aria-live="polite">
            <div className="digest-card">
                <span className="panel-label">Round Complete</span>
                <div className="digest-events">
                    {relicsFound > 0 && (
                        <div className="digest-event digest-event-relic">
                            {relicsFound} relic{relicsFound === 1 ? '' : 's'} claimed from the ruin
                        </div>
                    )}
                    {stealCount > 0 && (
                        <div className="digest-event digest-event-steal">
                            {stealCount} relic{stealCount === 1 ? '' : 's'} changed hands in shadow
                        </div>
                    )}
                    {escapedCount > 0 && (
                        <div className="digest-event digest-event-escape">
                            {escapedCount} hunter{escapedCount === 1 ? '' : 's'} broke for daylight
                        </div>
                    )}
                    {damagedCount > 0 && (
                        <div className="digest-event digest-event-damage">
                            {damagedCount} hunter{damagedCount === 1 ? '' : 's'} took the castle's toll
                        </div>
                    )}
                    {collapsedCount > 0 && (
                        <div className="digest-event digest-event-collapse">
                            {collapsedCount} chamber{collapsedCount === 1 ? '' : 's'} surrendered to ruin
                        </div>
                    )}
                    {relicsFound === 0 && escapedCount === 0 && damagedCount === 0 &&
                        collapsedCount === 0 && stealCount === 0 && (
                        <div className="digest-event">The ruin stayed quiet this round.</div>
                    )}
                </div>
                <span className="digest-hint">tap to dismiss</span>
                <div className="digest-progress"/>
            </div>
        </div>
    );
}

function LockedPlanCard({
    action,
    snapshot,
    localPlayerId,
}: Readonly<{
    action: RelicActionInput;
    snapshot: RelicPublicSnapshot;
    localPlayerId?: string;
}>) {
    const active = snapshot.players.filter((p) => !p.escaped && !p.defeated);
    const submitted = active.filter((p) => snapshot.submittedPlayerIds.includes(p.playerId));
    const waiting = active.filter((p) => !snapshot.submittedPlayerIds.includes(p.playerId));

    const actionLabel = (): string => {
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
    };

    return (
        <div className="locked-plan-card">
            <span className="panel-label">Plan Locked</span>
            <strong className="locked-action-label">{actionLabel()}</strong>
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

function EscapeDecisionPanel({
    snapshot,
    localPlayerId,
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    localPlayerId?: string;
}>) {
    const sortedPlayers = [...snapshot.players].sort((a, b) => b.score - a.score);
    const localPlayer = snapshot.players.find((p) => p.playerId === localPlayerId);
    const localRank = sortedPlayers.findIndex((p) => p.playerId === localPlayerId) + 1;
    const carriedRelics = snapshot.relics.filter((r) => r.carriedBy === localPlayerId);
    const escapeScore = localPlayer && !localPlayer.escaped && !localPlayer.defeated
        ? localPlayer.score + carriedRelics.reduce((sum, r) => sum + r.value, 0)
        : undefined;
    const roundsLeft = snapshot.maxRounds - snapshot.round + 1;
    const hiddenRelicTotal = snapshot.relics
        .filter((r) => !r.foundBy && !r.carriedBy && !r.escapedBy)
        .reduce((sum, r) => sum + r.value, 0);

    return (
        <div className="panel stack escape-decision">
            <div>
                <span className="panel-label">Score Tracker</span>
                <strong>
                    {localPlayer?.escaped
                        ? 'You escaped safe'
                        : localPlayer?.defeated
                        ? 'You are down'
                        : `Rank ${localRank} of ${snapshot.players.length}`}
                </strong>
                {carriedRelics.length > 0 && (
                    <small>Carrying {carriedRelics.length} {plural('relic', carriedRelics.length)}</small>
                )}
            </div>
            {carriedRelics.length > 0 && (
                <div className="relic-inventory">
                    {carriedRelics.map((r) => (
                        <div key={r.id} className="relic-item">
                            <span className="relic-item-name">◆ {r.name}</span>
                            <span className="relic-item-value">+{r.value}</span>
                        </div>
                    ))}
                </div>
            )}
            <div className="score-board">
                {sortedPlayers.map((player, rank) => {
                    const character = findRelicCharacter(player.characterId);
                    const isLocal = player.playerId === localPlayerId;
                    const maxHealth = 3 + (character.healthBonus ?? 0);
                    return (
                        <div
                            key={player.playerId}
                            className={`score-row${isLocal ? ' local' : ''}`}
                        >
                            <span className="score-rank" style={{ color: character.colors.accent }}>
                                {rank + 1}
                            </span>
                            <span className="score-name">{player.username}</span>
                            <span className="score-health" aria-label={`${player.health} health`}>
                                {Array.from({ length: maxHealth }, (_, i) => (
                                    <span
                                        key={i}
                                        className={`health-pip ${i < player.health ? 'pip-full' : 'pip-empty'} ${player.health === 1 && i === 0 ? 'pip-critical' : ''}`}
                                    />
                                ))}
                            </span>
                            <strong className="score-value">{player.score}</strong>
                            {player.relicIds.length > 0 && (
                                <span className="score-relics">◆{player.relicIds.length}</span>
                            )}
                            {player.escaped && <em className="score-status">out</em>}
                            {player.defeated && <em className="score-status score-status-down">down</em>}
                        </div>
                    );
                })}
            </div>
            {escapeScore !== undefined && snapshot.phase === 'planning' && (
                <div className="escape-projection">
                    <div className="escape-proj-row">
                        <span>Safe now</span>
                        <strong className="proj-safe">{escapeScore} pts</strong>
                    </div>
                    <div className="escape-proj-row">
                        <span>Still in ruin</span>
                        <strong>~{hiddenRelicTotal} pts</strong>
                    </div>
                    <div className={`escape-proj-row${roundsLeft <= 2 ? ' proj-urgent' : ''}`}>
                        <span>Rounds left</span>
                        <strong>{roundsLeft}</strong>
                    </div>
                </div>
            )}
        </div>
    );
}

function VictoryPanel({ snapshot }: Readonly<{ snapshot: RelicPublicSnapshot }>) {
    const winners = snapshot.players.filter((player) =>
        snapshot.winnerIds.includes(player.playerId)
    );
    const sortedPlayers = [...snapshot.players].sort((left, right) => right.score - left.score);
    const confettiPieces = useMemo(() =>
        Array.from({ length: 20 }, (_, i) => ({
            key: i,
            color: ['#facc5b', '#4ade80', '#7dd3fc', '#c4b5fd', '#fb7185'][i % 5],
            left: `${5 + ((i * 73 + 17) % 90)}%`,
            delay: `${(i * 137) % 2200}ms`,
            duration: `${1800 + (i * 79) % 1400}ms`,
            size: `${6 + (i * 31) % 9}px`,
        })),
    []);

    return (
        <section className="victory-panel">
            <div className="victory-confetti" aria-hidden="true">
                {confettiPieces.map((p) => (
                    <div
                        key={p.key}
                        className="confetti-piece"
                        style={{
                            left: p.left,
                            background: p.color,
                            animationDelay: p.delay,
                            animationDuration: p.duration,
                            width: p.size,
                            height: p.size,
                        }}
                    />
                ))}
            </div>
            <div>
                <span>The Heart Relic has chosen</span>
                <h2>{winners.map((winner) => winner.username).join(', ') || 'No hunter'}</h2>
                <p>Final score: {winners[0]?.score ?? 0}</p>
            </div>
            <div className="scoreboard">
                {sortedPlayers.map((player) => {
                    const char = findRelicCharacter(player.characterId);
                    const escapedRelics = snapshot.relics.filter((r) => r.escapedBy === player.playerId);
                    return (
                        <div key={player.playerId} className="final-score-row">
                            <span
                                className="final-score-swatch"
                                style={{ background: char.colors.accent }}
                            />
                            <span className="final-score-name">{player.username}</span>
                            <div className="final-score-details">
                                {escapedRelics.length > 0 && (
                                    <span className="final-score-relics">
                                        {escapedRelics.map((r) => `◆ ${r.name} (+${r.value})`).join('  ')}
                                    </span>
                                )}
                                {player.defeated && <span className="final-score-tag danger">fallen</span>}
                                {player.escaped && <span className="final-score-tag success">escaped</span>}
                                {!player.defeated && !player.escaped && <span className="final-score-tag">still inside</span>}
                            </div>
                            <strong className="final-score-value">{player.score}</strong>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

function RoomDetailCard({
    snapshot,
    roomId,
    localPlayerId,
    exitDistances,
    onPrimeMove,
    onDismiss,
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    roomId: string;
    localPlayerId?: string;
    exitDistances: Map<string, number>;
    onPrimeMove(roomId: string): void;
    onDismiss(): void;
}>) {
    const room = snapshot.map.find((r) => r.id === roomId);
    if (!room) return null;

    const localPlayer = snapshot.players.find((p) => p.playerId === localPlayerId);
    const localRoom = localPlayer ? snapshot.map.find((r) => r.id === localPlayer.roomId) : undefined;
    const isReachable = !room.collapsed && !!(localRoom?.neighbors.includes(roomId));
    const isCurrentRoom = localPlayer?.roomId === roomId;
    const canPrimeMove = isReachable &&
        !isCurrentRoom &&
        snapshot.phase === 'planning' &&
        !!localPlayer &&
        !localPlayer.escaped &&
        !localPlayer.defeated &&
        !snapshot.submittedPlayerIds.includes(localPlayer.playerId);

    const occupants = snapshot.players.filter(
        (p) => p.roomId === roomId && !p.escaped && !p.defeated,
    );
    const investigations = (snapshot.roomInvestigations ?? []).filter(
        (inv) => inv.roomId === roomId,
    );
    const foundRelics = snapshot.relics.filter(
        (r) => r.roomId === roomId && r.foundBy && !r.carriedBy && !r.escapedBy,
    );
    const dist = exitDistances.get(roomId);

    return (
        <div className="panel room-detail-card">
            <div className="room-detail-header">
                <strong>{room.name}</strong>
                <span className={`room-kind-pill room-kind-${room.kind}`}>{room.kind}</span>
                {dist !== undefined && (
                    <span className="room-detail-dist">{dist}→exit</span>
                )}
                <button
                    type="button"
                    className="room-detail-close"
                    aria-label="Close room detail"
                    onClick={onDismiss}
                >×</button>
            </div>
            {room.collapsed && (
                <p className="room-detail-status danger">This room has collapsed.</p>
            )}
            {room.unstable && !room.collapsed && (
                <p className="room-detail-status warn">Unstable — may collapse next round.</p>
            )}
            {occupants.length > 0 && (
                <div className="room-detail-occupants">
                    {occupants.map((player) => {
                        const char = findRelicCharacter(player.characterId);
                        return (
                            <span
                                key={player.playerId}
                                className="room-detail-occupant"
                                style={{ borderColor: char.colors.accent }}
                            >
                                {player.username}
                                {player.relicIds.length > 0 && ` ◆${player.relicIds.length}`}
                            </span>
                        );
                    })}
                </div>
            )}
            {investigations.map((inv) => (
                <div key={`${inv.roomId}-${inv.searchedAtRound}`} className="room-detail-intel">
                    <em>{inv.searchedByUsername} searched round {inv.searchedAtRound}</em>
                    <span>{inv.summary}</span>
                    {inv.hint && <small>{inv.hint}</small>}
                </div>
            ))}
            {foundRelics.map((r) => (
                <div key={r.id} className="room-detail-relic">◆ {r.name} — unclaimed</div>
            ))}
            {canPrimeMove && (
                <button type="button" className="primary" onClick={() => onPrimeMove(roomId)}>
                    Prime Move → {room.name}
                </button>
            )}
        </div>
    );
}

function TurnDiffStrip({ events }: Readonly<{ events: readonly RelicEvent[] }>) {
    const lastTurnRound = [...events].reverse().find(isTurnResultEvent)?.round;
    if (lastTurnRound === undefined) return null;

    const diffEvents = events.filter(
        (e) => e.round === lastTurnRound && isTurnResultEvent(e),
    );
    if (diffEvents.length === 0) return null;

    return (
        <div className="turn-diff-strip" aria-label={`Round ${lastTurnRound} results`}>
            <span className="turn-diff-label">R{lastTurnRound}</span>
            {diffEvents.map((e) => (
                <span key={e.id} className={`turn-diff-event tone-${e.tone ?? 'neutral'}`}>
                    {turnDiffSymbol(e.type)} {e.message}
                </span>
            ))}
        </div>
    );
}

function PersonalRoundCard({
    events,
    localPlayerId,
}: Readonly<{ events: readonly RelicEvent[]; localPlayerId?: string }>) {
    if (!localPlayerId) return null;

    const lastTurnRound = [...events].reverse().find(isTurnResultEvent)?.round;
    if (lastTurnRound === undefined) return null;

    const personal = events.filter(
        (e) => e.round === lastTurnRound && isTurnResultEvent(e) && isPersonalEvent(e, localPlayerId),
    );
    if (personal.length === 0) return null;

    return (
        <div className="panel personal-round-card">
            <span className="panel-label">Your Round {lastTurnRound}</span>
            <div className="personal-round-list">
                {personal.map((e) => (
                    <div key={e.id} className={`personal-round-entry tone-${e.tone ?? 'neutral'}`}>
                        <span className="personal-round-symbol">{turnDiffSymbol(e.type)}</span>
                        <span>{e.message}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function turnDiffSymbol(type: RelicEventType): string {
    switch (type) {
        case 'player_moved': return '→';
        case 'player_searched': return '?';
        case 'relic_found': return '◆';
        case 'steal_succeeded': return '^';
        case 'steal_failed': return 'x';
        case 'escape_failed': return 'x';
        case 'player_escaped': return '+';
        case 'player_damaged': return '!';
        case 'room_collapsed': return '#';
        case 'room_unstable': return '~';
        case 'noise_pulse': return '~';
        default: return '·';
    }
}

function HunterList({
    players,
    localPlayerId,
    phase,
    submittedPlayerIds,
}: Readonly<{
    players: readonly RelicPlayer[];
    localPlayerId?: string;
    phase?: RelicPublicSnapshot['phase'];
    submittedPlayerIds: readonly string[];
}>) {
    return (
        <div className="hunter-list">
            {players.map((player) => (
                <HunterChip
                    key={player.playerId}
                    player={player}
                    localPlayerId={localPlayerId}
                    phase={phase}
                    submitted={submittedPlayerIds.includes(player.playerId)}
                />
            ))}
        </div>
    );
}

function HunterChip({
    player,
    localPlayerId,
    phase,
    submitted,
}: Readonly<{
    player: RelicPlayer;
    localPlayerId?: string;
    phase?: RelicPublicSnapshot['phase'];
    submitted: boolean;
}>) {
    const character = findRelicCharacter(player.characterId);
    const maxHealth = 3 + (character.healthBonus ?? 0);
    const status = player.escaped
        ? 'escaped'
        : player.defeated
        ? 'down'
        : phase === 'planning'
        ? submitted
            ? 'submitted'
            : 'choosing'
        : player.roomId;
    return (
        <div
            className={[
                'hunter-chip',
                player.playerId === localPlayerId ? 'active' : '',
                submitted ? 'submitted' : '',
                player.defeated ? 'defeated' : '',
            ].filter(Boolean).join(' ')}
        >
            <span
                className="hunter-dot"
                style={{ background: character.colors.accent }}
            />
            <strong>{player.username}</strong>
            <span>{player.score}</span>
            {!player.escaped && !player.defeated && (
                <span className="hunter-chip-health" aria-label={`${player.health} health`}>
                    {Array.from({ length: maxHealth }, (_, i) => (
                        <span
                            key={i}
                            className={`hunter-chip-pip${i >= player.health ? ' empty' : ''}${player.health === 1 && i === 0 ? ' critical' : ''}`}
                        />
                    ))}
                </span>
            )}
            <small>
                {character.role} / {status}
            </small>
        </div>
    );
}

function toProgress(
    snapshot: RelicPublicSnapshot,
    localPlayerId: string | undefined,
): Readonly<{ relics: string; escape: string }> {
    const foundCount = snapshot.relics.filter((relic) => relic.foundBy).length;
    const escapedCount = snapshot.players.filter((player) => player.escaped).length;
    const localPlayer = snapshot.players.find((player) => player.playerId === localPlayerId);

    return {
        relics: `${foundCount}/${snapshot.relics.length}`,
        escape: localPlayer?.escaped
            ? 'safe'
            : `${escapedCount}/${Math.max(snapshot.players.length, 1)}`,
    };
}

function toObjective(
    snapshot: RelicPublicSnapshot,
    currentPlayer: RelicPlayer | undefined,
): string {
    if (snapshot.phase === 'finished') {
        return snapshot.winnerIds.length > 0
            ? 'The highest score has claimed the Heart Relic.'
            : 'The ruin has gone silent.';
    }

    if (!currentPlayer) {
        return 'Join the expedition to enter the ruin.';
    }

    if (snapshot.phase === 'lobby') {
        return 'Gather hunters, then start the expedition.';
    }

    if (currentPlayer.escaped) {
        return 'You escaped. Watch whether the others can beat your score.';
    }

    if (currentPlayer.defeated) {
        return 'You are down. The ruin keeps your relics.';
    }

    if (snapshot.submittedPlayerIds.includes(currentPlayer.playerId)) {
        const waiting = activePlayerCount(snapshot) - snapshot.submittedPlayerIds.length;
        return waiting > 0
            ? `Plan locked. Waiting for ${waiting} hunter${waiting === 1 ? '' : 's'}.`
            : 'All plans are locked. The ruin is about to answer.';
    }

    const roundsLeft = snapshot.maxRounds - snapshot.round + 1;
    return `Find relics, then escape within ${roundsLeft} round${roundsLeft === 1 ? '' : 's'}.`;
}

function activePlayerCount(snapshot: RelicPublicSnapshot): number {
    return snapshot.players.filter((player) => !player.escaped && !player.defeated).length;
}

function partyActionHint({
    actionKind,
    currentRoom,
    hereCount,
    elsewhereCount,
    stealTargets,
    relicCarrierCount,
}: Readonly<{
    actionKind: RelicActionKind;
    currentRoom: RelicPublicSnapshot['map'][number];
    hereCount: number;
    elsewhereCount: number;
    stealTargets: readonly RelicPlayer[];
    relicCarrierCount: number;
}>): string {
    if (actionKind === 'steal') {
        if (stealTargets.length === 0) {
            return 'No one nearby to steal from.';
        }
        if (relicCarrierCount > 0) {
            const carrier = stealTargets.find((player) => player.relicIds.length > 0);
            return carrier
                ? `Steal is possible here: ${carrier.username} carries ${carrier.relicIds.length} ${plural('relic', carrier.relicIds.length)}.`
                : 'Steal is possible here.';
        }
        return 'Hunters are here, but no one carries a relic.';
    }

    if (actionKind === 'search') {
        return hereCount > 1
            ? `Searching makes noise for ${hereCount} ${plural('hunter', hereCount)} in ${currentRoom.name}.`
            : 'You are searching alone; nearby hunters cannot share the risk.';
    }

    if (actionKind === 'escape') {
        return currentRoom.kind === 'exit'
            ? 'Escaping now banks your carried relics before the party risks another round.'
            : 'Escape only works from the Exit room.';
    }

    return elsewhereCount > 0
        ? `Coordinate before the castle reacts; ${elsewhereCount} ${plural('hunter', elsewhereCount)} ${elsewhereCount === 1 ? 'is' : 'are'} elsewhere.`
        : 'The active party is together in this room.';
}

function actionBlocker(
    snapshot: RelicPublicSnapshot,
    player: RelicPlayer,
    draft: ActionDraft,
    moveTargets: readonly string[],
    stealTargets: readonly RelicPlayer[],
): string | undefined {
    if (snapshot.phase !== 'planning') {
        return 'Start the expedition before locking plans.';
    }

    if (player.escaped) {
        return 'You are already safe outside the ruin.';
    }

    if (player.defeated) {
        return 'You are down and cannot act this expedition.';
    }

    if (draft.kind === 'move' && moveTargets.length === 0) {
        return 'No open adjacent paths from this room.';
    }

    if (draft.kind === 'steal' && stealTargets.length === 0) {
        return 'Steal needs another active hunter in this room.';
    }

    if (draft.kind === 'escape' && player.roomId !== 'exit') {
        return 'Escape only works from the Exit room.';
    }

    return undefined;
}

function chronicleHeadline(
    event: RelicEvent | undefined,
    phase: RelicPublicSnapshot['phase'] | undefined,
): string {
    if (!event) {
        return phase === 'lobby' ? 'The ruin waits.' : 'Listen for the next echo.';
    }

    switch (event.type) {
        case 'game_waiting':
            return 'The castle holds its breath.';
        case 'player_joined':
            return 'A new hunter enters the ruin.';
        case 'round_started':
            return 'The expedition presses on.';
        case 'action_submitted':
            return 'A plan sealed in silence.';
        case 'action_revealed':
            return 'The fates are set in motion.';
        case 'player_moved':
            return 'Footsteps echo through the dark.';
        case 'player_searched':
            return 'The ruin yields its secrets slowly.';
        case 'relic_found':
            return 'Treasure breaks the silence.';
        case 'steal_succeeded':
            return 'Trust is the first casualty.';
        case 'steal_failed':
            return 'Some things resist the taking.';
        case 'escape_failed':
            return 'The castle holds fast.';
        case 'player_escaped':
            return 'Daylight is close.';
        case 'noise_pulse':
            return 'The ruin hears everything.';
        case 'player_damaged':
            return 'The castle draws blood.';
        case 'room_unstable':
            return 'The walls begin to speak.';
        case 'room_collapsed':
            return 'Stone gives way.';
        case 'game_finished':
            return 'The expedition is over.';
        default:
            return event.message;
    }
}

const NARRATOR_LINES: Partial<Record<RelicEventType, readonly string[]>> = {
    game_waiting: ['The ruin holds its breath.'],
    player_joined: ['Another soul answers the call.', 'The expedition grows bolder.'],
    round_started: ["The torches hold their breath.", "A new round stirs the castle's bones."],
    action_submitted: ['A plan is whispered into the dark.', 'Choices made in silence.'],
    action_revealed: ['Plans unravel in the flickering dark.', 'The castle watches as fates unfold.'],
    player_moved: [
        'Footfalls fade into shadow.',
        'The corridor swallows another hunter.',
        'Stone whispers of passage.',
    ],
    player_searched: [
        'Dust disturbed by desperate hands.',
        'Old secrets resist new fingers.',
        'Every clue costs time.',
    ],
    relic_found: [
        'The ancient stirs. Something answers.',
        'Fortune paid in danger.',
        'Gold gleams where none expected.',
    ],
    steal_succeeded: ["Trust collapses in the dark.", "One hunter's prize becomes another's."],
    steal_failed: ['Greed grasps and finds only air.', 'Some things are not so easily taken.'],
    escape_failed: ['The ruin holds fast.', 'The castle will not release you yet.'],
    player_escaped: ['Daylight claims another soul.', 'The ruin loosens its grip.'],
    noise_pulse: [
        'The walls remember every whisper.',
        'Stone carries sound to distant ears.',
        'Something in the dark takes note.',
    ],
    player_damaged: [
        'The castle exacts its toll.',
        "Pain is the ruin's oldest currency.",
        'Stone and shadow take their due.',
    ],
    room_unstable: [
        'A crack traces the ceiling like a curse.',
        'The walls breathe wrong.',
        'This room will not last.',
    ],
    room_collapsed: [
        'Dust and darkness swallow the chamber.',
        'What stood for centuries surrenders.',
        'The ruin reclaims what it lent.',
    ],
    game_finished: [
        'The expedition breathes its last.',
        'What was sought is either found or lost forever.',
    ],
};

function narratorLine(event: RelicEvent): string {
    const lines = NARRATOR_LINES[event.type];
    if (!lines || lines.length === 0) return '';
    return lines[event.id.charCodeAt(event.id.length - 1) % lines.length];
}

function isPersonalEvent(event: RelicEvent, localPlayerId: string | undefined): boolean {
    if (!localPlayerId) return false;
    return event.animationCue?.playerId === localPlayerId ||
        event.animationCue?.targetPlayerId === localPlayerId;
}

function toneClass(event: RelicEvent | undefined): string {
    return event?.tone ? `tone-${event.tone}` : 'tone-neutral';
}

function plural(word: string, count: number): string {
    return count === 1 ? word : `${word}s`;
}

function phaseLabel(value: string): string {
    switch (value) {
        case 'lobby':
            return 'Gather hunters';
        case 'planning':
            return 'Choose secretly';
        case 'finished':
            return 'Expedition complete';
        case 'connected':
            return 'Choose a room';
        case 'connecting':
            return 'Opening the gate';
        case 'signed-out':
            return 'Sign in';
        default:
            return value;
    }
}

function Status({ label, value }: Readonly<{ label: string; value: string }>) {
    return (
        <div className="status-pill">
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

function WinLeader({ snapshot }: Readonly<{ snapshot?: RelicPublicSnapshot }>) {
    if (!snapshot || snapshot.phase === 'lobby') {
        return <Status label="Leader" value="-"/>;
    }
    const leader = [...snapshot.players].sort((a, b) => {
        const aScore = a.score + snapshot.relics.filter((r) => r.carriedBy === a.playerId).reduce((s, r) => s + r.value, 0);
        const bScore = b.score + snapshot.relics.filter((r) => r.carriedBy === b.playerId).reduce((s, r) => s + r.value, 0);
        return bScore - aScore;
    })[0];
    if (!leader) return <Status label="Leader" value="-"/>;
    const projectedScore = leader.score +
        snapshot.relics.filter((r) => r.carriedBy === leader.playerId).reduce((s, r) => s + r.value, 0);
    return (
        <div className="status-pill">
            <span>Leader</span>
            <strong>{leader.username.length > 8 ? leader.username.slice(0, 7) + '…' : leader.username} · {projectedScore}</strong>
        </div>
    );
}

function RoundStatus({ round, maxRounds }: Readonly<{ round: number; maxRounds: number }>) {
    const pct = Math.min(100, (round / maxRounds) * 100);
    const urgentClass = pct >= 70 ? 'round-urgent' : pct >= 45 ? 'round-near' : '';
    return (
        <div className={`status-pill round-status ${urgentClass}`}>
            <span>Round</span>
            <strong>{round} / {maxRounds}</strong>
            <div className="round-bar-track" aria-hidden="true">
                <div className="round-bar-fill" style={{ width: `${pct}%` }}/>
            </div>
        </div>
    );
}

function castleMapExitDistances(map: RelicPublicSnapshot['map']): Map<string, number> {
    const distances = new Map<string, number>();
    const exitRoom = map.find((room) => room.kind === 'exit');
    if (!exitRoom) return distances;
    const queue: string[] = [exitRoom.id];
    distances.set(exitRoom.id, 0);
    while (queue.length > 0) {
        const currentId = queue.shift()!;
        const current = map.find((room) => room.id === currentId);
        if (!current) continue;
        for (const neighborId of current.neighbors) {
            if (distances.has(neighborId)) continue;
            const neighbor = map.find((room) => room.id === neighborId);
            if (!neighbor || neighbor.collapsed) continue;
            distances.set(neighborId, distances.get(currentId)! + 1);
            queue.push(neighborId);
        }
    }
    return distances;
}

function castleMapExitPath(
    map: RelicPublicSnapshot['map'],
    fromRoomId: string,
): readonly string[] | undefined {
    const exitRoom = map.find((r) => r.kind === 'exit');
    if (!exitRoom) return undefined;
    if (fromRoomId === exitRoom.id) return [fromRoomId];
    const visited = new Set<string>([fromRoomId]);
    const queue: Array<readonly string[]> = [[fromRoomId]];
    while (queue.length > 0) {
        const path = queue.shift()!;
        const current = map.find((r) => r.id === path[path.length - 1]);
        if (!current) continue;
        for (const neighborId of current.neighbors) {
            if (visited.has(neighborId)) continue;
            const neighbor = map.find((r) => r.id === neighborId);
            if (!neighbor || neighbor.collapsed) continue;
            const next = [...path, neighborId];
            if (neighborId === exitRoom.id) return next;
            visited.add(neighborId);
            queue.push(next);
        }
    }
    return undefined;
}

function castleMapBounds(map: RelicPublicSnapshot['map']): CastleMapBounds {
    const xs = map.map((room) => room.x);
    const zs = map.map((room) => room.z);
    return {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minZ: Math.min(...zs),
        maxZ: Math.max(...zs),
    };
}

function castleMapPoint(
    room: RelicPublicSnapshot['map'][number],
    bounds: CastleMapBounds,
): Readonly<{ x: number; y: number }> {
    const padding = 12;
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const depth = Math.max(1, bounds.maxZ - bounds.minZ);
    return {
        x: padding + ((room.x - bounds.minX) / width) * (100 - padding * 2),
        y: padding + ((room.z - bounds.minZ) / depth) * (100 - padding * 2),
    };
}

function castleMapPlayerOffset(index: number): Readonly<{ x: number; y: number }> {
    const angle = (Math.PI * 2 * index) / 4;
    return {
        x: Math.cos(angle) * 2.6,
        y: Math.sin(angle) * 2.6,
    };
}

function roomKindMapColor(room: RelicPublicSnapshot['map'][number]): string {
    if (room.collapsed) return '#514a3f';
    if (room.unstable) return '#df7a4560';
    switch (room.kind) {
        case 'exit': return '#7dd3fc30';
        case 'treasure': return '#b7e66e30';
        case 'shrine': return '#b9a7f430';
        case 'monster': return '#b86f7f30';
        case 'trap': return '#f19a6430';
        case 'storage': return '#c69b5f30';
        default: return '#93b7aa18';
    }
}

function roomName(
    snapshot: { map: readonly { id: string; name: string }[] } | undefined,
    roomId: string,
): string {
    return snapshot?.map.find((room) => room.id === roomId)?.name ?? roomId;
}

function shortId(id: string): string {
    return id.length <= 8 ? id : id.slice(0, 8);
}

function RelicProgressPill({ relics }: Readonly<{
    relics?: RelicPublicSnapshot['relics'];
}>) {
    if (!relics) return <Status label="Relics" value="-"/>;
    const found = relics.filter((r) => r.foundBy).length;
    const escaped = relics.filter((r) => r.escapedBy).length;
    const total = relics.length;
    const pct = total > 0 ? Math.round((found / total) * 100) : 0;
    const escapedPct = total > 0 ? Math.round((escaped / total) * 100) : 0;
    return (
        <div className="status-pill relic-progress-pill">
            <span>Relics</span>
            <strong>{found}/{total}</strong>
            {escaped > 0 && <small>{escaped} safe</small>}
            <div className="relic-bar-track" aria-hidden="true">
                <div className="relic-bar-fill" style={{ width: `${pct}%` }}/>
                {escaped > 0 && (
                    <div className="relic-bar-escaped" style={{ width: `${escapedPct}%` }}/>
                )}
            </div>
        </div>
    );
}

function SceneMinimapOverlay({
    snapshot,
    localPlayerId,
}: Readonly<{ snapshot: RelicPublicSnapshot; localPlayerId?: string }>) {
    if (snapshot.phase === 'lobby') return null;
    const bounds = castleMapBounds(snapshot.map);
    const localPlayer = snapshot.players.find((p) => p.playerId === localPlayerId);

    const edges = snapshot.map.flatMap((room) =>
        room.neighbors
            .filter((nId) => room.id < nId)
            .map((nId) => {
                const neighbor = snapshot.map.find((r) => r.id === nId);
                if (!neighbor) return null;
                const from = castleMapPoint(room, bounds);
                const to = castleMapPoint(neighbor, bounds);
                return { key: `${room.id}-${nId}`, from, to };
            })
            .filter((e): e is NonNullable<typeof e> => e !== null)
    );

    return (
        <div className="scene-minimap" aria-hidden="true">
            <svg viewBox="0 0 100 100">
                {edges.map((e) => (
                    <line
                        key={e.key}
                        x1={e.from.x} y1={e.from.y}
                        x2={e.to.x} y2={e.to.y}
                        className="minimap-edge"
                    />
                ))}
                {snapshot.map.map((room) => {
                    const pt = castleMapPoint(room, bounds);
                    const isLocal = localPlayer?.roomId === room.id;
                    return (
                        <circle
                            key={room.id}
                            cx={pt.x} cy={pt.y}
                            r={isLocal ? 4.5 : 2.8}
                            className={[
                                'minimap-room',
                                `minimap-${room.kind}`,
                                isLocal ? 'minimap-local' : '',
                                room.collapsed ? 'minimap-collapsed' : '',
                            ].filter(Boolean).join(' ')}
                        />
                    );
                })}
                {snapshot.players
                    .filter((p) => !p.escaped && !p.defeated && p.playerId !== localPlayerId)
                    .map((p) => {
                        const room = snapshot.map.find((r) => r.id === p.roomId);
                        if (!room) return null;
                        const pt = castleMapPoint(room, bounds);
                        const char = findRelicCharacter(p.characterId);
                        return (
                            <circle
                                key={p.playerId}
                                cx={pt.x} cy={pt.y}
                                r={2.2}
                                fill={char.colors.accent}
                                className="minimap-player"
                            />
                        );
                    })}
            </svg>
        </div>
    );
}
