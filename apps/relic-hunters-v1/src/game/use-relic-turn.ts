import { useEffect, useEffectEvent, useRef, useState } from 'react';

import type { RelicActionInput, RelicActionKind, RelicEvent, RelicPublicSnapshot } from '@relic-hunters/mod.ts';

import { deriveRelicGameViewModel, type ActionDraft, type RelicGameViewModel } from './game-view-model.ts';
import type { RelicHuntersRuntime } from './relic-hunters-runtime.ts';
import { deriveSceneObjective, type SceneObjective } from './scene/objectives.ts';
import { playActionSound, playUiSound } from './sound.ts';
import type { RelicPreferences } from './use-relic-preferences.ts';

export interface RelicTurnSelection {
    readonly draft: ActionDraft;
    readonly primedAction: RelicActionInput | undefined;
    readonly roomId: string | undefined;
    setRoomId(roomId: string | undefined): void;
    prime(action: RelicActionInput): void;
}

export interface RelicTurnActions {
    readonly lockedAction: RelicActionInput | undefined;
    submit(): Promise<void>;
    selectKind(kind: RelicActionKind): void;
    selectMove(roomId: string): void;
    selectSteal(playerId: string): void;
    cycleTarget(direction: -1 | 1): void;
    continueReview(): Promise<void>;
}

export interface RelicTurn {
    readonly selection: RelicTurnSelection;
    readonly viewModel: RelicGameViewModel;
    readonly sceneObjective: SceneObjective;
    readonly actions: RelicTurnActions;
    readonly timeRemainingMs: number | null;
    readonly planning: boolean;
    readonly reviewing: boolean;
}

export function useRelicTurn(
    game: RelicHuntersRuntime.Connection,
    preferences: RelicPreferences,
    revealedEvents: readonly RelicEvent[]
): RelicTurn {
    const selection = useRelicTurnSelection(game);
    const viewModel = deriveRelicGameViewModel({
        snapshot: game.snapshot,
        localPlayerId: game.session?.sessionId,
        draft: selection.draft,
        lang: preferences.lang,
        revealedEvents
    });
    const actions = useRelicTurnActions({ game, selection, viewModel, enableAmbient: preferences.enableAmbient });
    const timeRemainingMs = useRelicRoundClock(game.snapshot, viewModel.turnStatus.canSubmit, actions.submit);
    useRelicTurnKeyboard({
        phase: game.snapshot?.phase,
        actions,
        canSubmit: viewModel.turnStatus.canSubmit,
        preferences
    });
    const player = viewModel.currentPlayer;
    return {
        selection,
        viewModel,
        actions,
        timeRemainingMs,
        sceneObjective: deriveSceneObjective({
            snapshot: game.snapshot,
            localPlayerId: game.session?.sessionId,
            primedAction: selection.primedAction
        }),
        planning: game.snapshot?.phase === 'planning' && !!player && !player.escaped && !player.defeated,
        reviewing: game.snapshot?.phase === 'review' && !!player
    };
}

function useRelicTurnSelection(game: RelicHuntersRuntime.Connection): RelicTurnSelection {
    const [draft, setDraft] = useState<ActionDraft>({ kind: 'search' });
    const [primedAction, setPrimedAction] = useState<RelicActionInput | undefined>();
    const [roomId, setRoomId] = useState<string | undefined>();
    const currentRoomId = game.snapshot?.players.find((player) => player.playerId === game.session?.sessionId)?.roomId;
    useEffect(() => {
        setPrimedAction(undefined);
    }, [currentRoomId, game.snapshot?.phase, game.snapshot?.round]);
    useEffect(() => {
        setDraft({ kind: 'search' });
        setRoomId(undefined);
        setPrimedAction(undefined);
    }, [game.roomId, game.session?.sessionId]);
    const prime = (action: RelicActionInput) => {
        playUiSound('select');
        setDraft(action);
        setPrimedAction(action);
        if (action.kind === 'move' && action.targetRoomId) {
            setRoomId(action.targetRoomId);
        }
    };
    return { draft, primedAction, roomId, setRoomId, prime };
}

interface RelicTurnActionsInput {
    readonly game: RelicHuntersRuntime.Connection;
    readonly selection: RelicTurnSelection;
    readonly viewModel: RelicGameViewModel;
    readonly enableAmbient: () => void;
}

function useRelicTurnActions({ game, selection, viewModel, enableAmbient }: RelicTurnActionsInput): RelicTurnActions {
    const [lockedAction, setLockedAction] = useState<RelicActionInput | undefined>();
    const continueReview = useRelicReviewContinuation(game, viewModel.isAdmin);
    useEffect(() => {
        setLockedAction(undefined);
    }, [game.roomId, game.session?.sessionId, game.snapshot?.round]);
    const submit = async () => {
        const action = toSelectedRelicAction(selection.draft, selection.roomId, viewModel);
        setLockedAction(action);
        playActionSound(action.kind);
        enableAmbient();
        await game.submitAction(action);
    };
    return {
        lockedAction,
        submit,
        continueReview,
        selectKind: (kind) => selection.prime(toSelectedRelicAction({ kind }, selection.roomId, viewModel)),
        selectMove: (targetRoomId) => selection.prime({ kind: 'move', targetRoomId }),
        selectSteal: (targetPlayerId) => selection.prime({ kind: 'steal', targetPlayerId }),
        cycleTarget: (direction) => cycleRelicTarget(selection, viewModel, direction)
    };
}

function toSelectedRelicAction(
    draft: ActionDraft,
    selectedRoomId: string | undefined,
    viewModel: RelicGameViewModel
): RelicActionInput {
    const selectedRoom = selectedRoomId && viewModel.moveTargets.includes(selectedRoomId)
        ? selectedRoomId
        : undefined;
    if (draft.kind === 'move') {
        return {
            kind: draft.kind,
            targetRoomId: draft.targetRoomId ?? selectedRoom ?? viewModel.moveTargets[0]
        };
    }
    if (draft.kind === 'steal') {
        return { kind: draft.kind, targetPlayerId: draft.targetPlayerId ?? viewModel.stealTargets[0]?.playerId };
    }
    return { kind: draft.kind };
}

function cycleRelicTarget(
    selection: RelicTurnSelection,
    viewModel: RelicGameViewModel,
    direction: -1 | 1
): void {
    const action = toSelectedRelicAction(selection.draft, selection.roomId, viewModel);
    if (action.kind === 'move' && viewModel.moveTargets.length > 1) {
        const index = Math.max(0, viewModel.moveTargets.indexOf(action.targetRoomId ?? ''));
        const targetRoomId =
            viewModel.moveTargets[(index + direction + viewModel.moveTargets.length) % viewModel.moveTargets.length];
        selection.prime({ kind: 'move', targetRoomId });
    }
    if (action.kind === 'steal' && viewModel.stealTargets.length > 1) {
        const index = Math.max(
            0,
            viewModel.stealTargets.findIndex((player) => player.playerId === action.targetPlayerId)
        );
        const target =
            viewModel.stealTargets[(index + direction + viewModel.stealTargets.length) % viewModel.stealTargets.length];
        selection.prime({ kind: 'steal', targetPlayerId: target.playerId });
    }
}

function useRelicReviewContinuation(game: RelicHuntersRuntime.Connection, isAdmin: boolean): () => Promise<void> {
    const inFlight = useRef<string | undefined>(undefined);
    const sent = useRef<string | undefined>(undefined);
    return async () => {
        const snapshot = game.snapshot;
        if (!snapshot || snapshot.phase !== 'review' || !isAdmin) {
            return;
        }
        const key = `${snapshot.gameId}:${snapshot.round}:${snapshot.updatedAtEpochMs}`;
        if (inFlight.current === key || sent.current === key) {
            return;
        }
        inFlight.current = key;
        playUiSound('start');
        try {
            await game.continueReview();
            sent.current = key;
        }
        finally {
            if (inFlight.current === key) {
                inFlight.current = undefined;
            }
        }
    };
}

function useRelicRoundClock(
    snapshot: RelicPublicSnapshot | undefined,
    canSubmit: boolean,
    submit: () => Promise<void>
): number | null {
    const [remaining, setRemaining] = useState<number | null>(null);
    const submitted = useRef<string | undefined>(undefined);
    const tick = useEffectEvent(() => {
        if (!snapshot || snapshot.phase !== 'planning' || !snapshot.roundStartedAtEpochMs) {
            setRemaining(null);
            return;
        }
        const next = snapshot.roundStartedAtEpochMs + snapshot.roundTimeLimitMs - Date.now();
        setRemaining(next);
        const key = `${snapshot.gameId}:${snapshot.round}`;
        if (next <= 0 && submitted.current !== key && canSubmit) {
            submitted.current = key;
            void submit();
        }
    });
    useEffect(() => {
        tick();
        const interval = window.setInterval(tick, 250);
        return () => clearInterval(interval);
    }, [
        snapshot?.gameId,
        snapshot?.phase,
        snapshot?.roundStartedAtEpochMs,
        snapshot?.roundTimeLimitMs,
        snapshot?.round
    ]);
    return remaining;
}

interface RelicTurnKeyboardInput {
    readonly phase: RelicPublicSnapshot['phase'] | undefined;
    readonly actions: RelicTurnActions;
    readonly canSubmit: boolean;
    readonly preferences: RelicPreferences;
}

function useRelicTurnKeyboard({ phase, actions, canSubmit, preferences }: RelicTurnKeyboardInput): void {
    const onKey = useEffectEvent((event: KeyboardEvent) => {
        if (isTypingRelicInput(event.target) || phase !== 'planning') {
            return;
        }
        const kind = relicActionKey(event.key);
        if (kind) {
            event.preventDefault();
            actions.selectKind(kind);
        }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            actions.cycleTarget(event.key === 'ArrowRight' ? 1 : -1);
        }
        else if (event.key === 'Enter' && canSubmit) {
            event.preventDefault();
            void actions.submit();
        }
        else if (event.key === '?' || event.key === 'F1') {
            event.preventDefault();
            preferences.setHelpVisible(!preferences.helpVisible);
        }
        else if (event.key === 'Escape') {
            preferences.setHelpVisible(false);
        }
    });
    useEffect(() => {
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
}

function isTypingRelicInput(target: EventTarget | null): boolean {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
}

function relicActionKey(key: string): RelicActionKind | undefined {
    switch (key) {
        case '1':
            return 'move';
        case '2':
            return 'search';
        case '3':
            return 'steal';
        case '4':
            return 'escape';
        default:
            return undefined;
    }
}
