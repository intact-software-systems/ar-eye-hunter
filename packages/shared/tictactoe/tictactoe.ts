import {
    ApplyMoveResult,
    BoardMove,
    Cell,
    CpuDifficulty,
    GameMode,
    GameModeType,
    GameResult,
    GameState, MoveIndex,
    Player
} from "./types.ts";

const EMPTY_BOARD: readonly Cell[] = Array(9).fill(Cell.Empty);

const WINNING_LINES: readonly number[][] = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
] as const;

/* =========================
   Game Creation
   ========================= */

export function createGame(
    mode: GameMode = {
        type: GameModeType.Cpu,
        difficulty: CpuDifficulty.Easy,
    },
): GameState {
    return {
        board: [...EMPTY_BOARD],
        currentPlayer: Player.X,
        result: GameResult.InProgress,
        mode,
    };
}

/* =========================
   Core Game Logic
   ========================= */

export function applyMove(
    state: GameState,
    moveIndex: number,
): ApplyMoveResult {
    // Default: move fails, state unchanged
    let outputState: GameState = state;
    let moveResult: BoardMove = BoardMove.Failed;

    // Game already finished → no moves allowed
    if (state.result !== GameResult.InProgress) {
        return {
            input: state,
            output: outputState,
            move: moveResult,
        };
    }

    // Invalid index
    if (
        moveIndex === MoveIndex.NA ||
        moveIndex < 0 ||
        moveIndex >= state.board.length
    ) {
        return {
            input: state,
            output: outputState,
            move: moveResult,
        };
    }

    // Cell already occupied
    if (state.board[moveIndex] !== Cell.Empty) {
        return {
            input: state,
            output: outputState,
            move: moveResult,
        };
    }

    // Apply move immutably
    const nextBoard: Cell[] = state.board.slice();
    nextBoard[moveIndex] = playerToCell(state.currentPlayer);

    const nextResult = determineGameResult(nextBoard);

    outputState = {
        board: nextBoard,
        currentPlayer: nextResult === GameResult.InProgress
            ? nextPlayer(state.currentPlayer)
            : Player.NA,
        result: nextResult,
        mode: state.mode,
    };

    moveResult = BoardMove.Succes;

    return {
        input: state,
        output: outputState,
        move: moveResult,
    };
}

/* =========================
   CPU Logic (Public API)
   ========================= */

export function computeCpuMove(
    game: GameState,
): number {
    if (game.mode.type !== GameModeType.Cpu) {
        return MoveIndex.NA.valueOf();
    }

    switch (game.mode.difficulty) {
        case CpuDifficulty.Easy:
            return randomMove(game.board);

        case CpuDifficulty.Medium:
            return mediumMove(game);

        case CpuDifficulty.Hard:
            return hardMove(game);
    }

    return MoveIndex.NA.valueOf();
}

/* =========================
   CPU Strategies
   ========================= */

function randomMove(board: readonly Cell[]): number {
    const empty = board
        .map((cell, idx) => (cell === Cell.Empty ? idx : -1))
        .filter((idx) => idx >= 0);

    return empty[Math.floor(Math.random() * empty.length)];
}

function mediumMove(game: GameState): number {
    const number = findWinningMove(game.board, playerToCell(game.currentPlayer));

    return number != MoveIndex.NA ? number : randomMove(game.board);
}

function hardMove(game: GameState): number {
    const cpu = game.currentPlayer;
    let bestScore = -Infinity;
    let bestMove = 0;

    for (let i = 0; i < 9; i++) {
        if (game.board[i] !== Cell.Empty) continue;

        const board = [...game.board];
        board[i] = cpu === Player.X ? Cell.X : Cell.O;

        const score = minimax(
            board,
            togglePlayer(cpu),
            cpu,
        );

        if (score > bestScore) {
            bestScore = score;
            bestMove = i;
        }
    }

    return bestMove;
}

/* =========================
   Minimax
   ========================= */

function minimax(
    board: readonly Cell[],
    player: Player,
    cpu: Player,
): number {
    const result = evaluateResult(board);

    if (result === GameResult.XWins) return cpu === Player.X ? 1 : -1;
    if (result === GameResult.OWins) return cpu === Player.O ? 1 : -1;
    if (result === GameResult.Draw) return 0;

    const maximizing = player === cpu;
    let best = maximizing ? -Infinity : Infinity;

    for (let i = 0; i < 9; i++) {
        if (board[i] !== Cell.Empty) continue;

        const next = [...board];
        next[i] = player === Player.X ? Cell.X : Cell.O;

        const score = minimax(
            next,
            togglePlayer(player),
            cpu,
        );

        best = maximizing ? Math.max(best, score) : Math.min(best, score);
    }

    return best;
}

// TODO: Improve algorithm findWinningMove later
export function findWinningMove(
    board: readonly Cell[],
    playerCell: Cell,
): number {
    if (playerCell === Cell.Empty) {
        return MoveIndex.NA;
    }

    for (const line of WINNING_LINES) {
        let emptyIndex = MoveIndex.NA;
        let playerCount = 0;

        for (const idx of line) {
            const cell = board[idx];

            if (cell === playerCell) {
                playerCount++;
            } else if (cell === Cell.Empty) {
                emptyIndex = idx;
            }
        }

        // Exactly two player cells + one empty → winning move
        if (playerCount === 2 && emptyIndex !== MoveIndex.NA) {
            return emptyIndex;
        }
    }

    return MoveIndex.NA;
}

/* =========================
   Helpers
   ========================= */

function togglePlayer(player: Player): Player {
    return player === Player.X ? Player.O : Player.X;
}

function evaluateResult(board: readonly Cell[]): GameResult {
    for (const [a, b, c] of WINNING_LINES) {
        if (
            board[a] !== Cell.Empty &&
            board[a] === board[b] &&
            board[a] === board[c]
        ) {
            return board[a] === Cell.X ? GameResult.XWins : GameResult.OWins;
        }
    }

    return board.every((cell) => cell !== Cell.Empty)
        ? GameResult.Draw
        : GameResult.InProgress;
}

function playerToCell(player: Player): Cell {
    switch (player) {
        case Player.X:
            return Cell.X;
        case Player.O:
            return Cell.O;
        case Player.NA:
            return Cell.Empty;
    }
}

function nextPlayer(player: Player): Player {
    switch (player) {
        case Player.X:
            return Player.O;
        case Player.O:
            return Player.X;
        case Player.NA:
            return Player.NA;
    }
}

function isBoardFull(board: readonly Cell[]): boolean {
    return board.every((cell) => cell !== Cell.Empty);
}

function hasPlayerWon(
    board: readonly Cell[],
    player: Player,
): boolean {
    if (player === Player.NA) {
        return false;
    }

    const cell = playerToCell(player);

    return WINNING_LINES.some((line) =>
        line.every((index) => board[index] === cell)
    );
}

function determineGameResult(
    board: readonly Cell[],
): GameResult {
    if (hasPlayerWon(board, Player.X)) {
        return GameResult.XWins;
    }
    if (hasPlayerWon(board, Player.O)) {
        return GameResult.OWins;
    }
    if (isBoardFull(board)) {
        return GameResult.Draw;
    }
    return GameResult.InProgress;
}
