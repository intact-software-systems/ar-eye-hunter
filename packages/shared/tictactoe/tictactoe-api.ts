import { BoardMove, GameState, Player, MoveIndex } from "./tictactoe.ts";

export type GameId = string;
export type ClientId = string;

/** Create game */
export interface CreateGameRequest {
    clientId: ClientId;
}

export interface CreateGameResponse {
    gameId: GameId;
    assignedPlayer: Player; // Player.X
    state: GameState;
}

/** Join game */
export interface JoinGameRequest {
    clientId: ClientId;
}

export interface JoinGameResponse {
    gameId: GameId;
    assignedPlayer: Player; // Player.O (or Player.NA if join rejected, depending on your policy)
    state: GameState;
}

/** Make move */
export interface MakeMoveRequest {
    clientId: ClientId;
    moveIndex: number; // use MoveIndex.NA on client if you need explicit “no move”
}

export interface MakeMoveResponse {
    gameId: GameId;
    moveIndex: number;
    move: BoardMove;
    state: GameState;
}

/** Get current state */
export interface GetGameResponse {
    gameId: GameId;
    state: GameState;
}