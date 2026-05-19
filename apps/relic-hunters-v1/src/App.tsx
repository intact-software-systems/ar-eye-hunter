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
import { IntroScene } from './game/IntroScene.tsx';
import { OpeningRelicScene } from './game/OpeningRelicScene.tsx';
import { RelicScene } from './game/RelicScene.tsx';
import { GameHudLayout } from './game/hud/GameHudLayout.tsx';
import {
    deriveRelicGameViewModel,
    RELIC_ACTION_KINDS,
    type ActionDraft,
} from './game/game-view-model.ts';
import {
    deriveCurrentTurnSummaryModel,
    isPersonalEvent,
    isTurnResultEvent,
    isTurnTimelineEvent,
    turnTimelineCategory,
} from './game/turn-summary.ts';
import type { RelicRuntimeDiagnostics } from './game/relic-hunters-runtime.ts';
import { UI, type Lang } from './game/lang.ts';
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
const IS_DEV = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
const INTRO_ENABLED = false;
const ONBOARDING_ENABLED = false;

export default function App() {
    const [introComplete, setIntroComplete] = useState(!INTRO_ENABLED);
    const [lang, setLang] = useState<Lang>(
        () => (localStorage.getItem('relic-lang') as Lang | null) ?? 'en',
    );
    const toggleLang = () => setLang((l) => {
        const next: Lang = l === 'en' ? 'no' : 'en';
        localStorage.setItem('relic-lang', next);
        return next;
    });
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
        () => ONBOARDING_ENABLED && !localStorage.getItem('relic-onboarding-v1'),
    );
    const [personalFlash, setPersonalFlash] = useState<{ tone: 'good' | 'bad'; key: number } | null>(null);
    const personalFlashKeyRef = useRef(0);
    const [lockedAction, setLockedAction] = useState<RelicActionInput | undefined>();
    const [showTensionBeat, setShowTensionBeat] = useState(false);
    const [showHelpOverlay, setShowHelpOverlay] = useState(false);
    const [sidePanelCollapsed, setSidePanelCollapsed] = useState(false);
    const [timeRemainingMs, setTimeRemainingMs] = useState<number | null>(null);
    const autoSubmittedForRoundRef = useRef<number | undefined>(undefined);
    const [phaseBanner, setPhaseBanner] = useState<string | null>(null);
    const [roomEntryFlash, setRoomEntryFlash] = useState<{ room: string; key: number } | null>(null);
    const roomEntryKeyRef = useRef(0);
    const prevPhaseRef = useRef<RelicPublicSnapshot['phase'] | undefined>(undefined);
    const prevRoomIdRef = useRef<string | undefined>(undefined);
    const tensionTimerRef = useRef<number | null>(null);
    const revealQueueRef = useRef<RelicEvent[]>([]);
    const revealTimerRef = useRef<number | null>(null);
    const revealNextRef = useRef<() => void>(null!);

    useEffect(() => {
        if (!IS_DEV) {
            return;
        }

        (window as unknown as {
            __relicHuntersRuntime?: ReturnType<typeof summarizeRelicHuntersRuntime>;
        }).__relicHuntersRuntime = summarizeRelicHuntersRuntime(
            game.roomId,
            game.diagnostics,
            game.snapshot,
        );
    }, [game.diagnostics, game.roomId, game.snapshot]);

    const viewModel = useMemo(
        () => deriveRelicGameViewModel({
            snapshot: game.snapshot,
            localPlayerId: game.session?.sessionId,
            draft,
            lang,
            revealedEvents,
        }),
        [draft, game.session?.sessionId, game.snapshot, lang, revealedEvents],
    );
    const currentPlayer = viewModel.currentPlayer;
    const currentRoom = viewModel.currentRoom;
    const sceneVisible = game.snapshot?.phase === 'planning' ||
        game.snapshot?.phase === 'review' ||
        game.snapshot?.phase === 'finished';
    const sceneInputEnabled = game.snapshot?.phase === 'planning' ||
        game.snapshot?.phase === 'finished';
    const currentRoomSummary = useMemo(
        () => game.rooms.find((room) => room.roomId === game.roomId),
        [game.roomId, game.rooms],
    );
    const selectedCharacter = findRelicCharacter(
        currentPlayer && game.snapshot?.phase !== 'lobby'
            ? currentPlayer.characterId
            : selectedCharacterId,
    );
    const moveTargets = viewModel.moveTargets;
    const exitDistances = useMemo(
        () => game.snapshot ? castleMapExitDistances(game.snapshot.map) : new Map<string, number>(),
        [game.snapshot],
    );
    const stealTargets = viewModel.stealTargets;
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
    const progress = viewModel.progress;
    const partyCoordination = game.snapshot
        ? derivePartyCoordination(game.snapshot, game.session?.sessionId, draft.kind)
        : undefined;
    const objective = viewModel.objective;
    const actionInfo = viewModel.actionInfo;
    const submitBlocker = viewModel.submitBlocker;
    const canSubmit = viewModel.turnStatus.canSubmit;
    const isLocked = viewModel.turnStatus.isLocked;
    const isAdmin = viewModel.isAdmin;
    const roundNoiseCount = viewModel.roundNoiseCount;
    const showPlanningControls = game.snapshot?.phase === 'planning' &&
        !!currentPlayer &&
        !currentPlayer.escaped &&
        !currentPlayer.defeated;
    const showReviewControls = game.snapshot?.phase === 'review' &&
        !!currentPlayer;
    const canForceResolveRound = showPlanningControls &&
        viewModel.turnStatus.waitingPlayerCount > 0 &&
        timeRemainingMs !== null &&
        timeRemainingMs <= 0;
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
    const lobbyStartBlocker = game.snapshot?.phase === 'lobby'
        ? deriveLobbyStartBlocker({
            snapshot: game.snapshot,
            currentPlayer,
            isAdmin,
            onlineMemberCount: currentRoomSummary?.onlineMemberCount,
            lang,
        })
        : undefined;

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

    useEffect(() => {
        if (game.snapshot?.phase !== 'planning' || !game.snapshot.roundStartedAtEpochMs) {
            setTimeRemainingMs(null);
            return;
        }
        const startMs = game.snapshot.roundStartedAtEpochMs;
        const limitMs = game.snapshot.roundTimeLimitMs;
        const round = game.snapshot.round;
        const tick = () => {
            const remaining = startMs + limitMs - Date.now();
            setTimeRemainingMs(remaining);
            if (remaining <= 0 && autoSubmittedForRoundRef.current !== round && canSubmitRef.current) {
                autoSubmittedForRoundRef.current = round;
                void submitActionRef.current();
            }
        };
        tick();
        const interval = window.setInterval(tick, 250);
        return () => clearInterval(interval);
    }, [game.snapshot?.phase, game.snapshot?.roundStartedAtEpochMs, game.snapshot?.roundTimeLimitMs, game.snapshot?.round]);

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
            const isGameStart = prevPhaseRef.current === 'lobby' && phase === 'planning';
            const msg = phase === 'planning' ? UI[lang].phaseBannerPlanning
                : phase === 'review' ? 'Plans are revealed.'
                : phase === 'finished' ? 'The ruin falls silent.'
                : null;
            if (msg) {
                setPhaseBanner(isGameStart ? `game-start:${msg}` : msg);
                const t = window.setTimeout(() => setPhaseBanner(null), isGameStart ? 4000 : 2400);
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

    const selectActionKind = useCallback((kind: RelicActionKind) => {
        playUiSound('select');
        const nextDraft: ActionDraft = kind === 'move'
            ? {
                kind,
                targetRoomId: selectedRoomId && moveTargets.includes(selectedRoomId)
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
        if (nextDraft.kind === 'move' && nextDraft.targetRoomId) {
            setSelectedRoomId(nextDraft.targetRoomId);
        }
    }, [moveTargets, selectedRoomId, stealTargets]);

    const selectMoveTarget = useCallback((targetRoomId: string) => {
        playUiSound('select');
        const nextDraft = {
            kind: 'move' as const,
            targetRoomId,
        };
        setSelectedRoomId(targetRoomId);
        setDraft(nextDraft);
        setScenePrimedAction(nextDraft);
    }, []);

    const selectStealTarget = useCallback((targetPlayerId: string) => {
        playUiSound('select');
        const nextDraft = {
            kind: 'steal' as const,
            targetPlayerId,
        };
        setDraft(nextDraft);
        setScenePrimedAction(nextDraft);
    }, []);

    const cycleSelectedTarget = useCallback((direction: -1 | 1) => {
        if (draft.kind === 'move' && moveTargets.length > 1) {
            const currentTarget = draft.targetRoomId ??
                (selectedRoomId && moveTargets.includes(selectedRoomId) ? selectedRoomId : moveTargets[0]);
            const index = Math.max(0, moveTargets.indexOf(currentTarget));
            const next = moveTargets[(index + direction + moveTargets.length) % moveTargets.length];
            selectMoveTarget(next);
            return;
        }

        if (draft.kind === 'steal' && stealTargets.length > 1) {
            const currentTarget = draft.targetPlayerId ?? stealTargets[0]?.playerId;
            const index = Math.max(0, stealTargets.findIndex((player) =>
                player.playerId === currentTarget
            ));
            const next = stealTargets[(index + direction + stealTargets.length) % stealTargets.length];
            selectStealTarget(next.playerId);
        }
    }, [
        draft.kind,
        draft.targetPlayerId,
        draft.targetRoomId,
        moveTargets,
        selectedRoomId,
        selectMoveTarget,
        selectStealTarget,
        stealTargets,
    ]);

    // Stable refs so closures (keyboard handler, timer) always call the latest versions.
    const submitActionRef = useRef(submitAction);
    submitActionRef.current = submitAction;
    const canSubmitRef = useRef(canSubmit);
    canSubmitRef.current = canSubmit;

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
                selectActionKind(kind);
                return;
            }

            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                cycleSelectedTarget(e.key === 'ArrowRight' ? 1 : -1);
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
    }, [canSubmit, cycleSelectedTarget, game.snapshot, selectActionKind]);

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

    const forceResolveRound = async () => {
        playUiSound('start');
        await game.forceResolveRound();
    };

    const continueReview = async () => {
        playUiSound('start');
        await game.continueReview();
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
    const jumpToSidePanelSection = useCallback((sectionId: string) => {
        document.getElementById(sectionId)?.scrollIntoView({
            block: 'start',
            behavior: 'auto',
        });
    }, []);

    return (
        <GameHudLayout
            scene={(
                sceneVisible
                    ? (
                        <RelicScene
                            snapshot={game.snapshot}
                            localPlayerId={game.session?.sessionId}
                            selectedRoomId={selectedRoomId}
                            primedAction={scenePrimedAction}
                            focusRoomId={eventFocusRoomId}
                            rtcReady={game.diagnostics.rtcReady}
                            inputEnabled={sceneInputEnabled}
                            onSelectRoom={setSelectedRoomId}
                            onPrimeAction={primeSceneAction}
                        />
                    )
                    : <OpeningRelicScene/>
            )}
            top={(
                <AppTopBar
                    phaseText={phaseLabel(game.snapshot?.phase ?? game.connectionState, lang)}
                    snapshot={game.snapshot}
                    onToggleHelp={() => setShowHelpOverlay((v) => !v)}
                />
            )}
            side={(
                <section className={`side-panel${sidePanelCollapsed ? ' collapsed' : ''}`}>
                <button
                    type="button"
                    className="side-panel-toggle"
                    onClick={() => setSidePanelCollapsed((v) => !v)}
                    title={sidePanelCollapsed ? 'Expand panel' : 'Collapse panel'}
                >
                    {sidePanelCollapsed ? '▶ Panel' : '◀ Collapse'}
                </button>
                {game.session && (
                    <SidePanelMenu
                        items={[
                            { id: 'hud-rooms', label: 'Rooms' },
                            ...(game.roomId
                                ? [{ id: 'hud-plan', label: game.snapshot?.phase === 'planning' ? 'Plan' : 'Party' }]
                                : []),
                            ...(game.roomId && game.snapshot
                                ? [
                                    { id: 'hud-map', label: 'Map' },
                                    { id: 'hud-intel', label: 'Intel' },
                                ]
                                : []),
                        ]}
                        onJump={jumpToSidePanelSection}
                    />
                )}
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
                        <div id="hud-rooms" className="panel stack">
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
                                <button type="button" onClick={toggleLang} title="Switch language / Bytt språk">
                                    {lang === 'en' ? 'Norsk' : 'English'}
                                </button>
                            </div>

                            <div className="room-list">
                                {rooms.map((room) => (
                                    <button
                                        type="button"
                                        key={room.roomId}
                                        data-room-id={room.roomId}
                                        className={room.roomId === game.roomId
                                            ? 'room-row active'
                                            : 'room-row'}
                                        onClick={() => {
                                            if (room.roomId !== game.roomId) {
                                                void game.joinRoom(room.roomId);
                                            }
                                        }}
                                    >
                                        <span>{room.name}</span>
                                        <small>{room.onlineMemberCount} online</small>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                {game.session && game.roomId && (
                    <div id="hud-plan" className="panel stack">
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

                        {game.snapshot && game.snapshot.phase === 'lobby' && (
                            <LobbyPartyPanel
                                snapshot={game.snapshot}
                                localPlayerId={game.session.sessionId}
                                onlineMemberCount={currentRoomSummary?.onlineMemberCount}
                                startBlocker={lobbyStartBlocker}
                                lang={lang}
                            />
                        )}

                        {(!game.snapshot || game.snapshot.phase === 'lobby') ? (
                            <div className="lobby-ready-zone">
                                {currentPlayer ? (
                                    <button type="button" className="lobby-ready-confirmed" disabled>
                                        {UI[lang].readyConfirmed}
                                    </button>
                                ) : (
                                    <button type="button" className="primary lobby-ready-btn" onClick={joinExpedition}>
                                        {lang === 'no' ? 'Bli med som' : 'Join as'} {selectedCharacter.name}
                                    </button>
                                )}
                                {currentPlayer && isAdmin && game.snapshot && (
                                    <div className="timer-limit-selector">
                                        <span className="panel-label">{UI[lang].setTimerTitle}</span>
                                        <div className="segmented">
                                            {([60_000, 180_000, 300_000] as const).map((ms) => (
                                                <button
                                                    key={ms}
                                                    type="button"
                                                    className={game.snapshot!.roundTimeLimitMs === ms ? 'active' : ''}
                                                    onClick={() => void game.setRoundLimit(ms)}
                                                >
                                                    {ms === 60_000 ? '1 min' : ms === 180_000 ? '3 min' : '5 min'}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {currentPlayer && isAdmin && (
                                    <button
                                        type="button"
                                        className="primary lobby-begin-btn"
                                        onClick={startExpedition}
                                        disabled={!!lobbyStartBlocker}
                                        title={lobbyStartBlocker}
                                    >
                                        {UI[lang].beginTheHunt}
                                    </button>
                                )}
                                {currentPlayer && isAdmin && lobbyStartBlocker && (
                                    <small className="lobby-start-hint">{lobbyStartBlocker}</small>
                                )}
                                {currentPlayer && !isAdmin && (
                                    <div className="lobby-waiting-admin">
                                        {UI[lang].waitingForKeeper}
                                    </div>
                                )}
                            </div>
                        ) : !currentPlayer ? (
                            <button type="button" onClick={joinExpedition}>
                                Join Expedition
                            </button>
                        ) : null}

                        <div className="button-grid">
                            <button type="button" onClick={resetExpedition}>
                                {lang === 'no' ? 'Tilbakestill' : 'Reset'}
                            </button>
                            <button
                                type="button"
                                className={ambientEnabled ? 'active' : ''}
                                onClick={toggleAmbient}
                            >
                                {lang === 'no' ? 'Atmosfære' : 'Atmosphere'}
                            </button>
                            <button type="button" onClick={toggleLang} title="Switch language / Bytt språk">
                                {lang === 'en' ? 'Norsk' : 'English'}
                            </button>
                        </div>

                        {showPlanningControls && game.snapshot && (
                            <section className="action-command-panel" aria-label="Round plan">
                                <TurnPlanStatusCard
                                    snapshot={game.snapshot}
                                    localPlayerId={game.session.sessionId}
                                />

                                {isLocked && (
                                    <LockedPlanCard
                                        action={lockedAction}
                                        snapshot={game.snapshot}
                                        localPlayerId={game.session.sessionId}
                                    />
                                )}

                                <div className="action-picker">
                                    {RELIC_ACTION_KINDS.map((kind, index) => {
                                        const option = viewModel.actionOptions[kind];
                                        const cq = option.consequence;
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
                                                    !option.legal ? 'action-option-blocked' : '',
                                                ].filter(Boolean).join(' ')}
                                                aria-pressed={draft.kind === kind}
                                                onClick={() => selectActionKind(kind)}
                                            >
                                                <span>
                                                    {option.info.label}
                                                    <kbd className="action-key">{index + 1}</kbd>
                                                </span>
                                                <small>{option.info.noise}</small>
                                                <em className={`action-cq action-cq-${cq.status}`}>{cq.text}</em>
                                            </button>
                                        );
                                    })}
                                </div>

                                <div className="action-brief">
                                    <strong>{actionInfo.label}</strong>
                                    <span>{actionInfo.description}</span>
                                    {isLocked && <small>Your submitted plan stays locked for this round.</small>}
                                    {submitBlocker && !isLocked && <small>{submitBlocker}</small>}
                                    {partyCoordination && <small>{partyCoordination.actionHint}</small>}
                                    {viewModel.actionBriefDanger && (
                                        <small className="action-brief-danger">! {viewModel.actionBriefDanger}</small>
                                    )}
                                </div>

                                {draft.kind === 'move' && (
                                    <MoveTargetChoices
                                        snapshot={game.snapshot}
                                        moveTargets={moveTargets}
                                        selectedRoomId={draft.targetRoomId ?? selectedRoomId ?? moveTargets[0]}
                                        exitDistances={exitDistances}
                                        onSelect={selectMoveTarget}
                                    />
                                )}

                                {draft.kind === 'steal' && (
                                    <StealTargetChoices
                                        stealTargets={stealTargets}
                                        selectedPlayerId={draft.targetPlayerId ?? stealTargets[0]?.playerId}
                                        onSelect={selectStealTarget}
                                    />
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

                                {viewModel.roundLimitWarning && (
                                    <div className={`round-warning ${viewModel.roundLimitWarning.severity === 'danger' ? 'round-warning-final' : ''}`}>
                                        {viewModel.roundLimitWarning.message}
                                    </div>
                                )}

                                {timeRemainingMs !== null && (
                                    <RoundTimer timeRemainingMs={timeRemainingMs} lang={lang}/>
                                )}

                                <button
                                    type="button"
                                    className="primary action-submit-button"
                                    disabled={!canSubmit}
                                    onClick={submitAction}
                                >
                                    {isLocked
                                        ? UI[lang].boundButton
                                        : <>{UI[lang].submitButton} <kbd className="action-key action-key-enter">↵</kbd></>}
                                </button>

                                {canForceResolveRound && (
                                    <div className="force-resolve-panel">
                                        <small>
                                            {viewModel.turnStatus.waitingPlayerCount} timed-out {plural('hunter', viewModel.turnStatus.waitingPlayerCount)}.
                                        </small>
                                        <button
                                            type="button"
                                            className="secondary action-force-resolve-button"
                                            onClick={forceResolveRound}
                                        >
                                            Resolve Timed-Out Round
                                        </button>
                                    </div>
                                )}
                            </section>
                        )}

                        {showReviewControls && game.snapshot && (
                            <section className="action-command-panel review-command-panel" aria-label="Round review">
                                <span className="panel-label">Round {game.snapshot.round} Review</span>
                                <div className="action-brief">
                                    <strong>Watch the revealed plans</strong>
                                    <span>Each hunter's move is now being replayed in the scene and timeline.</span>
                                    <small>Continue only after the party has seen the results.</small>
                                </div>
                                <button
                                    type="button"
                                    className="primary action-submit-button"
                                    onClick={continueReview}
                                >
                                    {willReviewEndGame(game.snapshot)
                                        ? 'Continue to finale'
                                        : 'Continue to next turn'}
                                </button>
                            </section>
                        )}
                    </div>
                )}

                {game.session && game.roomId && game.snapshot && (
                    <EscapeDecisionPanel
                        snapshot={game.snapshot}
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

                {IS_DEV && game.session && (
                    <RallarDiagnosticsPanel diagnostics={game.diagnostics}/>
                )}

                {game.error && <div className="panel error-panel">{game.error}</div>}
            </section>
            )}
            bottom={(
                <BottomHudPanel
                    snapshot={game.snapshot}
                    localPlayerId={game.session?.sessionId}
                    revealedEvents={revealedEvents}
                    lastEvent={lastEvent}
                    lang={lang}
                />
            )}
            floating={(
                <>
            {personalFlash && (
                <div
                    key={personalFlash.key}
                    className={`personal-event-flash flash-${personalFlash.tone}`}
                    onAnimationEnd={() => setPersonalFlash(null)}
                    aria-hidden="true"
                />
            )}

            {viewModel.lowHealthWarning && (
                <div className="low-health-banner" role="alert">
                    {viewModel.lowHealthWarning.message}
                </div>
            )}

            {showPlanningControls && (
                <div className="controls-hud" aria-hidden="true">
                    <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Move</span>
                    <span><kbd>Q</kbd><kbd>E</kbd> Turn</span>
                    <span><kbd>1</kbd>–<kbd>4</kbd> Pick action</span>
                    <span><kbd>←</kbd><kbd>→</kbd> Target</span>
                    <span><kbd>↵</kbd> Submit</span>
                </div>
            )}

            {showPlanningControls && game.snapshot && game.session && !game.snapshot.submittedPlayerIds.includes(game.session.sessionId) && (
                <div className="action-nudge" aria-live="polite">
                    {currentRoom
                        ? <RoomActionNudge room={currentRoom} lang={lang} />
                        : <span>Pick an action and submit</span>}
                </div>
            )}

            {game.snapshot && (
                <SceneMinimapOverlay
                    snapshot={game.snapshot}
                    localPlayerId={game.session?.sessionId}
                />
            )}

            {phaseBanner && (
                <div
                    className={`phase-banner${phaseBanner.startsWith('game-start:') ? ' phase-banner-start' : ''}`}
                    role="status"
                    aria-live="assertive"
                    aria-atomic="true"
                >
                    {phaseBanner.startsWith('game-start:') ? phaseBanner.slice('game-start:'.length) : phaseBanner}
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
                </>
            )}
            overlays={(
                <>
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

            {timeRemainingMs !== null && timeRemainingMs > 0 && timeRemainingMs <= 10_000 &&
                showPlanningControls && !isLocked && (
                <div className="round-countdown-overlay" role="status" aria-live="assertive">
                    <span className="round-countdown-number">{Math.ceil(timeRemainingMs / 1000)}</span>
                    <span className="round-countdown-label">s</span>
                </div>
            )}

            {INTRO_ENABLED && !introComplete && (
                <IntroScene onComplete={() => setIntroComplete(true)} lang={lang} />
            )}
                </>
            )}
        />
    );
}

function AppTopBar({
                       phaseText,
                       snapshot,
                       onToggleHelp,
                   }: Readonly<{
    phaseText: string;
    snapshot?: RelicPublicSnapshot;
    onToggleHelp(): void;
}>) {
    return (
        <section className="topbar">
            <div className="brand">
                <span className="brand-mark"/>
                <div>
                    <h1>Relic Hunters</h1>
                    <p>{phaseText}</p>
                </div>
            </div>
            <div className="status-row">
                {snapshot
                    ? <RoundStatus round={snapshot.round} maxRounds={snapshot.maxRounds}/>
                    : <Status label="Round" value="-"/>
                }
                <Status label="Hunters" value={String(snapshot?.players.length ?? 0)}/>
                <Status label="Submitted" value={String(snapshot?.submittedPlayerIds.length ?? 0)}/>
                <RelicProgressPill relics={snapshot?.relics}/>
                <WinLeader snapshot={snapshot}/>
                <button
                    type="button"
                    className="help-toggle"
                    aria-label="Keyboard shortcuts"
                    onClick={onToggleHelp}
                >?</button>
            </div>
        </section>
    );
}

function SidePanelMenu({
                           items,
                           onJump,
                       }: Readonly<{
    items: readonly Readonly<{ id: string; label: string }>[];
    onJump(id: string): void;
}>) {
    return (
        <nav className="side-panel-menu" aria-label="Side panel sections">
            {items.map((item) => (
                <button
                    key={item.id}
                    type="button"
                    onClick={() => onJump(item.id)}
                >
                    {item.label}
                </button>
            ))}
        </nav>
    );
}

function BottomHudPanel({
                            snapshot,
                            localPlayerId,
                            revealedEvents,
                            lastEvent,
                            lang,
                        }: Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    revealedEvents: readonly RelicEvent[];
    lastEvent?: RelicEvent;
    lang: Lang;
}>) {
    const hasPlayers = (snapshot?.players.length ?? 0) > 0;

    return (
        <section className={`bottom-panel${hasPlayers ? '' : ' compact'}`}>
            {hasPlayers && (
                <HunterList
                    players={snapshot?.players ?? []}
                    localPlayerId={localPlayerId}
                    phase={snapshot?.phase}
                    submittedPlayerIds={snapshot?.submittedPlayerIds ?? []}
                    lang={lang}
                />
            )}
            <TurnTimelinePanel
                snapshot={snapshot}
                localPlayerId={localPlayerId}
                events={revealedEvents}
                lastEvent={lastEvent}
                lang={lang}
            />
        </section>
    );
}

function TurnTimelinePanel({
    snapshot,
    localPlayerId,
    events,
    lastEvent,
    lang,
}: Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    events: readonly RelicEvent[];
    lastEvent?: RelicEvent;
    lang: Lang;
}>) {
    return (
        <div className="turn-timeline-panel">
            <CurrentTurnSummary
                snapshot={snapshot}
                localPlayerId={localPlayerId}
                events={events}
                lang={lang}
            />
            <RoundChronicle
                events={events}
                phase={snapshot?.phase}
                lastEvent={lastEvent}
                localPlayerId={localPlayerId}
            />
        </div>
    );
}

function CurrentTurnSummary({
    snapshot,
    localPlayerId,
    events,
    lang,
}: Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    events: readonly RelicEvent[];
    lang: Lang;
}>) {
    const summary = deriveCurrentTurnSummaryModel({
        snapshot,
        localPlayerId,
        events,
        lang,
    });

    return (
        <section className={`turn-summary turn-summary-${summary.copy.kind}`} aria-label="Current turn summary">
            <div className="turn-summary-copy">
                <span className="panel-label">{summary.copy.eyebrow}</span>
                <strong>{summary.copy.title}</strong>
                <small>{summary.copy.detail}</small>
            </div>
            <div className="turn-summary-stats" aria-label="Turn status">
                {summary.stats.map((stat) => <span key={stat}>{stat}</span>)}
            </div>
        </section>
    );
}

function RallarDiagnosticsPanel({
                                    diagnostics,
                                }: Readonly<{ diagnostics: RelicRuntimeDiagnostics }>) {
    return (
        <div className="panel stack rallar-diagnostics-panel" aria-label="Rallar diagnostics">
            <div>
                <span className="panel-label">Rallar</span>
                <strong>{diagnostics.phase}</strong>
            </div>
            <div className="diagnostic-grid">
                <DiagnosticFlag label="Auth" active={diagnostics.authenticated}/>
                <DiagnosticFlag label="Connect" active={diagnostics.middlewareConnected}/>
                <DiagnosticFlag label="Room" active={diagnostics.roomReady}/>
                <DiagnosticFlag label="Snapshot" active={diagnostics.snapshotReady}/>
                <DiagnosticFlag label="WS" active={diagnostics.wsListenerReady}/>
                <DiagnosticFlag label="Rooms" active={diagnostics.roomListenerReady}/>
                <DiagnosticFlag label="RTC" active={diagnostics.rtcReady}/>
            </div>
            {diagnostics.roomId && <small>Room {diagnostics.roomId}</small>}
            <small>Commands {diagnostics.commandTransport.toUpperCase()}</small>
            <small>Snapshots {diagnostics.snapshotTransport}</small>
            {diagnostics.lastSnapshotSource && <small>Last snapshot {diagnostics.lastSnapshotSource}</small>}
            {diagnostics.lastAcceptedSnapshot && (
                <small>
                    Accepted {diagnostics.lastAcceptedSnapshot.phase} r{diagnostics.lastAcceptedSnapshot.round} / {diagnostics.lastAcceptedSnapshot.eventCount} events / {diagnostics.lastAcceptedSnapshot.submittedCount} submitted
                </small>
            )}
            {diagnostics.ignoredSnapshotCount > 0 && (
                <small>Ignored stale snapshots {diagnostics.ignoredSnapshotCount}</small>
            )}
            {diagnostics.lastIgnoredSnapshotReason && (
                <small>Last ignored {diagnostics.lastIgnoredSnapshotReason}</small>
            )}
            {diagnostics.commandInFlight && <small>Command {diagnostics.commandInFlight}</small>}
            {diagnostics.lastError && <small className="diagnostic-error">{diagnostics.lastError}</small>}
        </div>
    );
}

function DiagnosticFlag({
                            label,
                            active,
                        }: Readonly<{ label: string; active: boolean }>) {
    return (
        <span className={`diagnostic-flag${active ? ' active' : ''}`}>
            {label}
        </span>
    );
}

function summarizeRelicHuntersRuntime(
    roomId: string | undefined,
    diagnostics: RelicRuntimeDiagnostics,
    snapshot: RelicPublicSnapshot | undefined,
) {
    const activePlayerCount = snapshot?.players.filter(
        (player) => !player.escaped && !player.defeated,
    ).length ?? 0;

    return {
        roomId,
        diagnostics,
        snapshot: snapshot
            ? {
                gameId: snapshot.gameId,
                roomId: snapshot.roomId,
                phase: snapshot.phase,
                round: snapshot.round,
                updatedAtEpochMs: snapshot.updatedAtEpochMs,
                playerIds: snapshot.players.map((player) => player.playerId),
                activePlayerCount,
                submittedPlayerIds: [...snapshot.submittedPlayerIds],
                eventIds: snapshot.events.map((event) => event.id),
                eventCount: snapshot.events.length,
            }
            : undefined,
    };
}

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

function RoomActionNudge({
    room,
    lang,
}: Readonly<{ room: RelicPublicSnapshot['map'][number]; lang: Lang }>) {
    const hints: Record<string, string> = lang === 'no' ? {
        monster: '⚔️ Monsterrom — Søk for å bekjempe, eller flytt deg',
        trap: '⚠️ Fellrom — Søk med forsiktighet, eller flytt deg',
        treasure: '💎 Skattkammer — Søk etter en relikvie!',
        shrine: '🌀 Helligdom — Søk for mystiske gaver',
        entrance: '🏯 Inngang — Velg en rute inn i slottet',
        exit: '🚪 Utgang — Bruk Unnslippe-handlingen hvis du har relikvier!',
        hallway: '🔦 Korridor — Fortsett inn i slottet',
    } : {
        monster: '⚔️ Monster room — Search to fight, or move away',
        trap: '⚠️ Trap room — Search carefully, or move away',
        treasure: '💎 Treasure room — Search for a relic!',
        shrine: '🌀 Shrine room — Search for mysterious gifts',
        entrance: '🏯 Entrance — Choose a route into the castle',
        exit: '🚪 Exit — Use Escape action if you carry relics!',
        hallway: '🔦 Corridor — Press onward into the castle',
    };
    const hint = hints[room.kind] ?? (lang === 'no' ? 'Velg en handling' : 'Choose an action');
    return <span>{hint}</span>;
}

function deriveLobbyStartBlocker({
    snapshot,
    currentPlayer,
    isAdmin,
    onlineMemberCount,
    lang,
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    currentPlayer?: RelicPlayer;
    isAdmin: boolean;
    onlineMemberCount?: number;
    lang: Lang;
}>): string | undefined {
    const joinedCount = snapshot.players.length;
    const onlineOnlyCount = typeof onlineMemberCount === 'number'
        ? Math.max(0, onlineMemberCount - joinedCount)
        : 0;
    const keeperName = getKeeperName(snapshot, lang);

    if (!currentPlayer) {
        return lang === 'no'
            ? 'Bli med i ekspedisjonen før jakten kan starte.'
            : 'Join the expedition before the hunt can start.';
    }
    if (!isAdmin) {
        return lang === 'no'
            ? `Bare ${keeperName} kan starte jakten.`
            : `Only ${keeperName} can start the hunt.`;
    }
    if (joinedCount === 0) {
        return lang === 'no'
            ? 'Minst én jeger må bli med i ekspedisjonen.'
            : 'At least one hunter must join the expedition.';
    }
    if (onlineOnlyCount > 0) {
        return lang === 'no'
            ? `${onlineOnlyCount} tilkoblet rommedlem må bli med i ekspedisjonen.`
            : `${onlineOnlyCount} online room member${onlineOnlyCount === 1 ? '' : 's'} must join the expedition.`;
    }
    return undefined;
}

function getLobbyKeeper(snapshot: RelicPublicSnapshot): RelicPlayer | undefined {
    const adminPlayerId = snapshot.adminPlayerId ?? snapshot.players[0]?.playerId;
    return snapshot.players.find((player) => player.playerId === adminPlayerId);
}

function getKeeperName(snapshot: RelicPublicSnapshot, lang: Lang): string {
    return getLobbyKeeper(snapshot)?.username ?? (lang === 'no' ? 'Vokteren' : 'the Keeper');
}

function LobbyPartyPanel({
    snapshot,
    localPlayerId,
    onlineMemberCount,
    startBlocker,
    lang,
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    localPlayerId?: string;
    onlineMemberCount?: number;
    startBlocker?: string;
    lang: Lang;
}>) {
    if (snapshot.phase !== 'lobby') return null;
    const u = UI[lang];
    const joinedCount = snapshot.players.length;
    const onlineKnown = typeof onlineMemberCount === 'number';
    const onlineCount = onlineMemberCount ?? joinedCount;
    const onlineOnlyCount = onlineKnown ? Math.max(0, onlineCount - joinedCount) : 0;
    const offlineJoinedCount = onlineKnown ? Math.max(0, joinedCount - onlineCount) : 0;
    const allJoinedOnline = joinedCount > 0 && onlineOnlyCount === 0 && offlineJoinedCount === 0;
    const keeper = getLobbyKeeper(snapshot);
    const adminPlayerId = snapshot.adminPlayerId ?? snapshot.players[0]?.playerId;
    return (
        <div className="panel lobby-party-panel">
            <div className="lobby-ready-header">
                <span className="panel-label">{u.huntersSummoned}</span>
                {(onlineKnown || joinedCount > 0) && (
                    <span className={`lobby-ready-count${allJoinedOnline ? ' all-ready' : ''}`}>
                        {joinedCount}/{onlineKnown ? onlineCount : '?'} {lang === 'no' ? 'med' : 'joined'}
                    </span>
                )}
            </div>
            <p className="lobby-keeper-watch">
                {keeper
                    ? (lang === 'no' ? `Vokter: ${keeper.username}` : `Keeper: ${keeper.username}`)
                    : u.keeperWatches}
            </p>
            <div className="lobby-party-summary" aria-label={lang === 'no' ? 'Lobby-medlemskap' : 'Lobby membership'}>
                <div className="lobby-party-stat">
                    <span>{lang === 'no' ? 'Tilkoblede rommedlemmer' : 'Online room members'}</span>
                    <strong>{onlineKnown ? onlineCount : '—'}</strong>
                </div>
                <div className="lobby-party-stat">
                    <span>{lang === 'no' ? 'Jegere i ekspedisjonen' : 'Joined expedition hunters'}</span>
                    <strong>{joinedCount}</strong>
                </div>
            </div>
            {snapshot.players.length > 0 && (
                <div className="lobby-party-list">
                    {snapshot.players.map((player) => {
                        const char = findRelicCharacter(player.characterId);
                        const isLocal = player.playerId === localPlayerId;
                        const isKeeper = player.playerId === adminPlayerId;
                        return (
                            <div key={player.playerId} className={`lobby-party-row${isLocal ? ' local' : ''}`}>
                                <span
                                    className="lobby-party-swatch"
                                    style={{ background: char.colors.accent }}
                                />
                                <span className="lobby-party-name">{player.username}</span>
                                <span className="lobby-party-char">{char.name}</span>
                                <span className="lobby-role-badges">
                                    {isKeeper && (
                                        <span className="lobby-role-badge">
                                            {lang === 'no' ? 'VOKTER' : 'KEEPER'}
                                        </span>
                                    )}
                                    <span className="lobby-ready-badge">
                                        {lang === 'no' ? 'KLAR' : 'READY'}
                                    </span>
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}
            {onlineOnlyCount > 0 ? (
                <small className="lobby-party-hint">
                    {lang === 'no'
                        ? `${onlineOnlyCount} tilkoblet rommedlem må bli med i ekspedisjonen.`
                        : `${onlineOnlyCount} online room member${onlineOnlyCount === 1 ? '' : 's'} still need${onlineOnlyCount === 1 ? 's' : ''} to join.`}
                </small>
            ) : offlineJoinedCount > 0 ? (
                <small className="lobby-party-hint warning">
                    {lang === 'no'
                        ? `${offlineJoinedCount} jeger${offlineJoinedCount === 1 ? '' : 'e'} i ekspedisjonen ser frakoblet ut.`
                        : `${offlineJoinedCount} joined hunter${offlineJoinedCount === 1 ? '' : 's'} appear offline.`}
                </small>
            ) : startBlocker ? (
                <small className="lobby-party-hint">{startBlocker}</small>
            ) : allJoinedOnline ? (
                <small className="lobby-all-ready-hint">
                    {lang === 'no'
                        ? 'Ekspedisjonen er samlet. Vokteren kan starte jakten.'
                        : 'The expedition is assembled. The Keeper can start when ready.'}
                </small>
            ) : (
                <small className="lobby-party-hint">{u.keeperAwaits}</small>
            )}
        </div>
    );
}

function RoundTimer({
    timeRemainingMs,
    lang,
}: Readonly<{ timeRemainingMs: number; lang: Lang }>) {
    const totalSecs = Math.max(0, Math.ceil(timeRemainingMs / 1000));
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    const display = `${mins}:${String(secs).padStart(2, '0')}`;
    const isUrgent = totalSecs <= 10;
    return (
        <div className={`round-timer${isUrgent ? ' round-timer-urgent' : ''}`}>
            <span>{UI[lang].timerLabel}</span>
            <strong>{display}</strong>
        </div>
    );
}

function TurnPlanStatusCard({
    snapshot,
    localPlayerId,
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    localPlayerId?: string;
}>) {
    const activePlayers = snapshot.players.filter((player) =>
        !player.escaped && !player.defeated
    );
    const submittedPlayers = activePlayers.filter((player) =>
        snapshot.submittedPlayerIds.includes(player.playerId)
    );
    const waitingPlayers = activePlayers.filter((player) =>
        !snapshot.submittedPlayerIds.includes(player.playerId)
    );
    const localSubmitted = !!localPlayerId &&
        snapshot.submittedPlayerIds.includes(localPlayerId);
    const waitingCount = waitingPlayers.length;
    const title = localSubmitted
        ? 'Plan locked'
        : waitingCount === 1 && waitingPlayers[0]?.playerId === localPlayerId
        ? 'Waiting on your plan'
        : 'Choose this round';
    const detail = localSubmitted
        ? waitingCount > 0
            ? `${waitingCount} ${plural('hunter', waitingCount)} still choosing.`
            : 'All plans locked.'
        : `${submittedPlayers.length}/${activePlayers.length} plans locked.`;

    return (
        <div className={`turn-plan-status${localSubmitted ? ' locked' : ''}`} aria-live="polite">
            <div>
                <span className="panel-label">Round {snapshot.round}</span>
                <strong>{title}</strong>
                <small>{detail}</small>
            </div>
            <div className="turn-plan-counters" aria-label="Planning progress">
                <span>{submittedPlayers.length} locked</span>
                <span>{waitingCount} waiting</span>
            </div>
        </div>
    );
}

function MoveTargetChoices({
    snapshot,
    moveTargets,
    selectedRoomId,
    exitDistances,
    onSelect,
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    moveTargets: readonly string[];
    selectedRoomId?: string;
    exitDistances: Map<string, number>;
    onSelect(roomId: string): void;
}>) {
    return (
        <div className="target-choice-section">
            <span className="panel-label">Move Target</span>
            {moveTargets.length === 0 ? (
                <div className="target-empty">No open adjacent paths.</div>
            ) : (
                <div className="target-choice-grid">
                    {moveTargets.map((roomId) => {
                        const room = snapshot.map.find((candidate) =>
                            candidate.id === roomId
                        );
                        const dist = exitDistances.get(roomId);
                        const hasRelic = snapshot.relics.some((relic) =>
                            relic.roomId === roomId &&
                            !relic.foundBy &&
                            !relic.carriedBy &&
                            !relic.escapedBy
                        );
                        const selected = selectedRoomId === roomId;
                        return (
                            <button
                                type="button"
                                key={roomId}
                                className={`target-option${selected ? ' active' : ''}`}
                                data-target-room-id={roomId}
                                aria-pressed={selected}
                                onClick={() => onSelect(roomId)}
                            >
                                <span className="target-option-title">
                                    {room?.name ?? roomId}
                                </span>
                                <span className="target-option-meta">
                                    {room?.kind ?? 'room'}
                                    {dist !== undefined ? ` / ${dist} to exit` : ''}
                                    {hasRelic ? ' / relic signal' : ''}
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function StealTargetChoices({
    stealTargets,
    selectedPlayerId,
    onSelect,
}: Readonly<{
    stealTargets: readonly RelicPlayer[];
    selectedPlayerId?: string;
    onSelect(playerId: string): void;
}>) {
    return (
        <div className="target-choice-section">
            <span className="panel-label">Steal Target</span>
            {stealTargets.length === 0 ? (
                <div className="target-empty">No active hunter in this room carries a target.</div>
            ) : (
                <div className="target-choice-grid">
                    {stealTargets.map((player) => {
                        const character = findRelicCharacter(player.characterId);
                        const selected = selectedPlayerId === player.playerId;
                        return (
                            <button
                                type="button"
                                key={player.playerId}
                                className={`target-option${selected ? ' active' : ''}`}
                                data-target-player-id={player.playerId}
                                aria-pressed={selected}
                                onClick={() => onSelect(player.playerId)}
                            >
                                <span className="target-option-title">{player.username}</span>
                                <span className="target-option-meta">
                                    {character.role} / {player.relicIds.length} {plural('relic', player.relicIds.length)} / {player.score} score
                                </span>
                            </button>
                        );
                    })}
                </div>
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
    const offlineJoinedCount = Math.max(0, expeditionPlayers - onlinePlayers);
    const onlineOnlyCount = Math.max(0, onlinePlayers - expeditionPlayers);
    const detail = offlineJoinedCount > 0
        ? 'Offline joined hunters can hold a round until the timer expires. Start Over removes the stale roster; Keep Going leaves them in the expedition.'
        : onlineOnlyCount > 0
        ? 'Some online room members have not joined the expedition yet. Start Over rebuilds the roster; Keep Going leaves the current expedition as-is.'
        : 'The expedition roster no longer matches the connected party.';
    return (
        <div className="panel stack party-change-panel">
            <div>
                <span className="panel-label">Party Changed</span>
                <strong>{onlinePlayers}/{expeditionPlayers} hunters are online</strong>
            </div>
            <p>{detail}</p>
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
        <div id="hud-intel" className="panel stack room-intel">
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
                                    {target ? ` - ${target.name}` : ' - no target'}
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
        <div id="hud-map" className="panel castle-map-panel">
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
            if (!isTurnTimelineEvent(e)) continue;
            const list = groups.get(e.round) ?? [];
            list.push(e);
            groups.set(e.round, list);
        }
        return [...groups.entries()]
            .sort((a, b) => b[0] - a[0])
            .slice(0, 3);
    }, [events]);

    return (
        <div className={`chronicle ${toneClass(lastEvent)}`} aria-label="Turn timeline">
            <div className="chronicle-title">
                <span>{phase === 'finished' ? 'Expedition End' : 'Turn Timeline'}</span>
                <strong>{chronicleHeadline(lastEvent, phase)}</strong>
            </div>
            <div className="chronicle-list chronicle-grouped">
                {roundGroups.length > 0 ? (
                    roundGroups.map(([round, roundEvents]) => (
                        <div key={round} className="chronicle-round-group">
                            <div className="chronicle-round-header">Round {round}</div>
                            {roundEvents
                                .slice(-6)
                                .reverse()
                                .map((event) => {
                                    const narLine = narratorLine(event);
                                    const personal = isPersonalEvent(event, localPlayerId);
                                    const category = turnTimelineCategory(event, localPlayerId);
                                    return (
                                        <div
                                            key={event.id}
                                            className={`chronicle-entry ${toneClass(event)} ${personal ? 'personal' : ''}`}
                                        >
                                            <div className="timeline-entry-meta">
                                                <span className={`timeline-category timeline-category-${category.kind}`}>
                                                    {category.label}
                                                </span>
                                                <span className="timeline-symbol">{turnDiffSymbol(event.type)}</span>
                                            </div>
                                            {narLine && <em className="narrator-voice">{narLine}</em>}
                                            <span className="chronicle-message">{event.message}</span>
                                        </div>
                                    );
                                })}
                        </div>
                    ))
                ) : (
                    <small className="chronicle-empty">Turn results will appear here as the castle resolves each round.</small>
                )}
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

function LockedPlanCard({
    action,
    snapshot,
    localPlayerId,
}: Readonly<{
    action?: RelicActionInput;
    snapshot: RelicPublicSnapshot;
    localPlayerId?: string;
}>) {
    const active = snapshot.players.filter((p) => !p.escaped && !p.defeated);
    const submitted = active.filter((p) => snapshot.submittedPlayerIds.includes(p.playerId));
    const waiting = active.filter((p) => !snapshot.submittedPlayerIds.includes(p.playerId));

    const actionLabel = (): string => {
        if (!action) {
            return 'Plan submitted';
        }

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
    lang,
}: Readonly<{
    players: readonly RelicPlayer[];
    localPlayerId?: string;
    phase?: RelicPublicSnapshot['phase'];
    submittedPlayerIds: readonly string[];
    lang: Lang;
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
                    lang={lang}
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
    lang,
}: Readonly<{
    player: RelicPlayer;
    localPlayerId?: string;
    phase?: RelicPublicSnapshot['phase'];
    submitted: boolean;
    lang: Lang;
}>) {
    const character = findRelicCharacter(player.characterId);
    const maxHealth = 3 + (character.healthBonus ?? 0);
    const u = UI[lang];
    const status = player.escaped
        ? 'escaped'
        : player.defeated
        ? 'down'
        : phase === 'planning'
        ? submitted
            ? u.bound
            : u.heedingTheCall
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

function toneClass(event: RelicEvent | undefined): string {
    return event?.tone ? `tone-${event.tone}` : 'tone-neutral';
}

function plural(word: string, count: number): string {
    return count === 1 ? word : `${word}s`;
}

function willReviewEndGame(snapshot: RelicPublicSnapshot): boolean {
    const active = snapshot.players.some((player) =>
        !player.escaped && !player.defeated
    );
    return snapshot.round + 1 > snapshot.maxRounds || !active;
}

function phaseLabel(value: string, lang: Lang): string {
    const u = UI[lang];
    switch (value) {
        case 'lobby':     return u.phaseLobby;
        case 'planning':  return u.phasePlanning;
        case 'review':    return u.phaseReview;
        case 'finished':  return u.phaseFinished;
        case 'connected': return u.phaseConnected;
        case 'connecting':return u.phaseConnecting;
        case 'signed-out':return u.phaseSignedOut;
        case 'authenticating': return 'Authenticating';
        case 'joining-room': return 'Joining room';
        case 'ready': return u.phaseConnected;
        case 'degraded': return 'Degraded';
        case 'error': return 'Connection error';
        default:          return value;
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
