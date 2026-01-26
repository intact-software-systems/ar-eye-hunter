import { BoardMove, GameState, Player } from '../tictactoe/types.ts'

export enum WsClientMsgType {
    Hello = "Hello",
    MakeMove = "MakeMove",
}

export enum WsServerMsgType {
    Welcome = "Welcome",
    StateUpdate = "StateUpdate",
    Error = "Error",
}

export type WsClientMessage =
    | {
    type: WsClientMsgType.Hello;
    clientId: string;
    gameId: string;
}
    | {
    type: WsClientMsgType.MakeMove;
    clientId: string;
    gameId: string;
    moveIndex: number;
};

export type WsServerMessage =
    | {
    type: WsServerMsgType.Welcome;
    gameId: string;
    assignedPlayer: Player;
    state: GameState;
}
    | {
    type: WsServerMsgType.StateUpdate;
    gameId: string;
    move: BoardMove;
    state: GameState;
}
    | {
    type: WsServerMsgType.Error;
    gameId: string;
    message: string;
};