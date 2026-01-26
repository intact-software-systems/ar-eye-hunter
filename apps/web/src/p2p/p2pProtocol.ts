import {
    BoardMove,
    Cell,
    CpuDifficulty,
    GameModeType,
    GameResult,
    type GameState,
    P2pRole,
    Player,
} from '@shared/mod.ts';

import {applyMove} from '@shared/tictactoe/tictactoe.ts';

export enum ProtocolDecision {
    Applied = 'Applied',
    Rejected = 'Rejected',
}

export enum RejectionReason {
    NotConnected = 'NotConnected',
    GameNotInProgress = 'GameNotInProgress',
    RoleUnknown = 'RoleUnknown',
    NotYourTurn = 'NotYourTurn',
    InvalidMove = 'InvalidMove',
}

export type Decision =
    | { decision: ProtocolDecision.Applied; next: GameState }
    | { decision: ProtocolDecision.Rejected; reason: RejectionReason };

export function emptyState(): GameState {
    return {
        board: Array(9).fill(Cell.Empty),
        currentPlayer: Player.X,
        result: GameResult.InProgress,
        mode: { type: GameModeType.LocalHuman, difficulty: CpuDifficulty.Empty },
    };
}

export function myPlayerFromRole(role: P2pRole): Player {
    switch (role) {
        case P2pRole.Initiator:
            return Player.X;
        case P2pRole.Responder:
            return Player.O;
    }
}

export function isMyTurn(state: GameState, myPlayer: Player): boolean {
    return state.result === GameResult.InProgress && state.currentPlayer === myPlayer;
}

export function applyLocalMove(args: {
    state: GameState;
    myRole: P2pRole;
    moveIndex: number;
}): Decision {
    if (args.state.result !== GameResult.InProgress) {
        return { decision: ProtocolDecision.Rejected, reason: RejectionReason.GameNotInProgress };
    }

    const me = myPlayerFromRole(args.myRole);

    if (!isMyTurn(args.state, me)) {
        return { decision: ProtocolDecision.Rejected, reason: RejectionReason.NotYourTurn };
    }

    const res = applyMove(args.state, args.moveIndex);

    if (res.move === BoardMove.Failed) {
        return { decision: ProtocolDecision.Rejected, reason: RejectionReason.InvalidMove };
    }

    return { decision: ProtocolDecision.Applied, next: res.output };
}

export function applyRemoteMove(args: {
    state: GameState;
    myRole: P2pRole;
    moveIndex: number;
}): Decision {
    if (args.state.result !== GameResult.InProgress) {
        return { decision: ProtocolDecision.Rejected, reason: RejectionReason.GameNotInProgress };
    }

    const me = myPlayerFromRole(args.myRole);
    const remotePlayer = me === Player.X ? Player.O : Player.X;

    // Remote can only move when it's remote's turn
    if (args.state.currentPlayer !== remotePlayer) {
        return { decision: ProtocolDecision.Rejected, reason: RejectionReason.NotYourTurn };
    }

    const res = applyMove(args.state, args.moveIndex);

    if (res.move === BoardMove.Failed) {
        return { decision: ProtocolDecision.Rejected, reason: RejectionReason.InvalidMove };
    }

    return { decision: ProtocolDecision.Applied, next: res.output };
}

/**
 * A tiny deterministic hash for divergence detection.
 * Not cryptographic. Just "good enough" for resync triggers.
 */
export function stateHash(state: GameState): string {
    const b = state.board.join('|');
    return `${b}::${state.currentPlayer}::${state.result}`;
}

export enum P2pMsgType {
    Hello = 'Hello',
    Move = 'Move',
    Reset = 'Reset',
    // hardening-ready:
    StateSync = 'StateSync',
    ResyncRequest = 'ResyncRequest',
    Error = 'Error',
}

export type P2pHelloMsg = { type: P2pMsgType.Hello; role: P2pRole };

export type P2pMoveMsg = { type: P2pMsgType.Move; moveIndex: number; hash: string };

export type P2pResetMsg = { type: P2pMsgType.Reset };

export type P2pStateSyncMsg = { type: P2pMsgType.StateSync; state: GameState; hash: string };

export type P2pResyncRequestMsg = { type: P2pMsgType.ResyncRequest; wantHash: string };

export type P2pErrorMsg = { type: P2pMsgType.Error; message: string };

export type P2pMsg =
    | P2pHelloMsg
    | P2pMoveMsg
    | P2pResetMsg
    | P2pStateSyncMsg
    | P2pResyncRequestMsg
    | P2pErrorMsg;

export function parseP2pMsg(raw: string): { kind: 'Ok'; msg: P2pMsg } | { kind: 'Invalid' } {
    try {
        const msg = JSON.parse(raw) as P2pMsg;
        if (!msg || typeof msg !== 'object') return { kind: 'Invalid' };
        return { kind: 'Ok', msg };
    } catch {
        return { kind: 'Invalid' };
    }
}

export function makeMoveMsg(moveIndex: number, next: GameState): P2pMoveMsg {
    return {
        type: P2pMsgType.Move,
        moveIndex,
        hash: stateHash(next),
    };
}

export function makeResyncRequestMsg(wantState: GameState): P2pResyncRequestMsg {
    return {
        type: P2pMsgType.ResyncRequest,
        wantHash: stateHash(wantState),
    };
}

export function makeStateSyncMsg(state: GameState): P2pStateSyncMsg {
    return {
        type: P2pMsgType.StateSync,
        state,
        hash: stateHash(state),
    };
}

/**
 * Validate a StateSync message is internally consistent.
 * If hash doesn't match state, treat it as invalid.
 */
export function validateStateSync(msg: P2pStateSyncMsg): { kind: 'Ok'; state: GameState } | { kind: 'Invalid' } {
    const computed = stateHash(msg.state);
    if (computed !== msg.hash) return { kind: 'Invalid' };
    return { kind: 'Ok', state: msg.state };
}
