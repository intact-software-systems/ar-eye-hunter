import {
    ApplyMoveResult,
    BoardMove,
    Cell,
    CpuDifficulty,
    GameModeType,
    GameResult,
    type GameState,
    Player,
} from '@shared/mod.ts';

import {applyMove} from '@shared/tictactoe/tictactoe.ts';

type GameId = string;
type ClientId = string;

type ServerGame = {
    id: GameId;
    state: GameState;
    players: { X: Player; O: Player };
    owners: { X: ClientId; O: ClientId };
};

const games = new Map<GameId, ServerGame>();

function newGameState(): GameState {
    return {
        board: Array(9).fill(Cell.Empty),
        currentPlayer: Player.X,
        result: GameResult.InProgress,
        mode: {type: GameModeType.LocalHuman, difficulty: CpuDifficulty.Empty},
    };
}

export function createGame(clientId: ClientId): ServerGame {
    const id = crypto.randomUUID();
    const game: ServerGame = {
        id,
        state: newGameState(),
        players: {X: Player.X, O: Player.O},
        owners: {X: clientId, O: ''},
    };
    games.set(id, game);
    return game;
}

export function joinGame(gameId: GameId, clientId: ClientId): ServerGame {
    const game = getGame(gameId);
    if (game.owners.O !== '') return game; // already joined; keep it simple for now
    game.owners.O = clientId;
    return game;
}

export function getGame(gameId: GameId): ServerGame {
    const game = games.get(gameId);
    if (!game) {
        throw new Error('Game not found');
    }
    return game;
}

function clientToPlayer(game: ServerGame, clientId: ClientId): Player {
    if (game.owners.X === clientId) return Player.X;
    if (game.owners.O === clientId) return Player.O;
    return Player.NA;
}

export function makeMove(gameId: GameId, clientId: ClientId, moveIndex: number): {
    move: BoardMove;
    state: GameState;
} {
    const game = getGame(gameId);

    // Must be joined by both players (you can relax this later)
    if (game.owners.O === '') {
        return {move: BoardMove.Failed, state: game.state};
    }

    const actingPlayer = clientToPlayer(game, clientId);
    if (actingPlayer === Player.NA) {
        return {move: BoardMove.Failed, state: game.state};
    }

    // Enforce turn ownership
    if (game.state.currentPlayer !== actingPlayer) {
        return {move: BoardMove.Failed, state: game.state};
    }

    const result: ApplyMoveResult = applyMove(game.state, moveIndex);

    if (result.move === BoardMove.Succes) {
        game.state = result.output; // server is authoritative
    }

    return {move: result.move, state: game.state};
}
