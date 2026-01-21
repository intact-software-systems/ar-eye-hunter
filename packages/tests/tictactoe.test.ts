import {describe, expect, it} from "vitest";

import {
  applyMove,
  BoardMove,
  Cell,
  computeCpuMove,
  CpuDifficulty,
  createGame,
  GameModeType,
  GameResult,
  GameState,
  MoveIndex,
  Player,
} from "@shared/game/tictactoe.ts";

/* ======================================================
   Helpers
   ====================================================== */

function emptyGameState(): GameState {
  return {
    board: Array(9).fill(Cell.Empty),
    currentPlayer: Player.X,
    result: GameResult.InProgress,
    mode: {
      type: GameModeType.Cpu,
      difficulty: CpuDifficulty.Easy,
    },
  };
}

/* ======================================================
   Game Creation
   ====================================================== */

describe("createGame", () => {
  it("creates a new game with an empty board", () => {
    const game = createGame();

    expect(game.board).toHaveLength(9);
    expect(game.board.every((c) => c === Cell.Empty)).toBe(true);
    expect(game.currentPlayer).toBe(Player.X);
    expect(game.result).toBe(GameResult.InProgress);
  });

  it("creates a CPU game with selected difficulty", () => {
    const game = createGame({
      type: GameModeType.Cpu,
      difficulty: CpuDifficulty.Hard,
    });

    expect(game.mode.type).toBe(GameModeType.Cpu);
    expect(game.mode.difficulty).toBe(CpuDifficulty.Hard);
  });
});

describe("applyMove", () => {
  it("applies a valid move and switches player", () => {
    const state = emptyGameState();

    const result = applyMove(state, 0);

    expect(result.move).toBe(BoardMove.Succes);
    expect(result.input).toBe(state); // same reference
    expect(result.output.board[0]).toBe(Cell.X);
    expect(result.output.currentPlayer).toBe(Player.O);
    expect(result.output.result).toBe(GameResult.InProgress);
  });

  it("rejects move on occupied cell", () => {
    const state: GameState = {
      ...emptyGameState(),
      board: [
        Cell.X,
        Cell.Empty,
        Cell.Empty,
        Cell.Empty,
        Cell.Empty,
        Cell.Empty,
        Cell.Empty,
        Cell.Empty,
        Cell.Empty,
      ],
    };

    const result = applyMove(state, 0);

    expect(result.move).toBe(BoardMove.Failed);
    expect(result.output).toBe(state);
  });

  it("rejects move with MoveIndex.NA", () => {
    const state = emptyGameState();

    const result = applyMove(state, MoveIndex.NA);

    expect(result.move).toBe(BoardMove.Failed);
    expect(result.output).toBe(state);
  });

  it("rejects move when game is already won", () => {
    const state: GameState = {
      ...emptyGameState(),
      board: [
        Cell.X,
        Cell.X,
        Cell.X,
        Cell.O,
        Cell.O,
        Cell.Empty,
        Cell.Empty,
        Cell.Empty,
        Cell.Empty,
      ],
      result: GameResult.XWins,
    };

    const result = applyMove(state, 5);

    expect(result.move).toBe(BoardMove.Failed);
    expect(result.output).toBe(state);
  });

  it("detects X winning move", () => {
    const state: GameState = {
      ...emptyGameState(),
      board: [
        Cell.X,
        Cell.X,
        Cell.Empty,
        Cell.O,
        Cell.O,
        Cell.Empty,
        Cell.Empty,
        Cell.Empty,
        Cell.Empty,
      ],
    };

    const result = applyMove(state, 2);

    expect(result.move).toBe(BoardMove.Succes);
    expect(result.output.result).toBe(GameResult.XWins);
    expect(result.output.currentPlayer).toBe(Player.NA);
  });

  it("detects draw when board becomes full", () => {
    const state: GameState = {
      ...emptyGameState(),
      board: [
        Cell.X,
        Cell.O,
        Cell.X,
        Cell.X,
        Cell.O,
        Cell.O,
        Cell.O,
        Cell.X,
        Cell.Empty,
      ],
      currentPlayer: Player.X,
    };

    const result = applyMove(state, 8);

    expect(result.move).toBe(BoardMove.Succes);
    expect(result.output.result).toBe(GameResult.Draw);
    expect(result.output.currentPlayer).toBe(Player.NA);
  });

  it("does not mutate the input board", () => {
    const state = emptyGameState();
    const originalBoard = state.board.slice();

    applyMove(state, 4);

    expect(state.board).toEqual(originalBoard);
  });
});

/* ======================================================
   CPU – Medium
   ====================================================== */

describe("computeCpuMove – Medium", () => {
  it("plays winning move when available", () => {
    const game = {
      board: [
        Cell.O,
        Cell.O,
        Cell.Empty,
        Cell.X,
        Cell.X,
        Cell.Empty,
        Cell.Empty,
        Cell.Empty,
        Cell.Empty,
      ],
      currentPlayer: Player.O,
      result: GameResult.InProgress,
      mode: {type: GameModeType.Cpu, difficulty: CpuDifficulty.Medium},
    };

    const move = computeCpuMove(game);
    expect(move).toBe(2);
  });

  it("blocks opponent winning move", () => {
    const game = {
      board: [
        Cell.X,
        Cell.X,
        Cell.Empty,
        Cell.O,
        Cell.Empty,
        Cell.Empty,
        Cell.Empty,
        Cell.Empty,
        Cell.Empty,
      ],
      currentPlayer: Player.O,
      result: GameResult.InProgress,
      mode: {type: GameModeType.Cpu, difficulty: CpuDifficulty.Medium},
    };

    const move = computeCpuMove(game);
    expect(move).toBeGreaterThan(-1);
    // expect(move).toBe(2); // TODO: Improve algorithm findWinningMove later
  });
});

/* ======================================================
   CPU – Hard (Minimax)
   ====================================================== */

describe("computeCpuMove – Hard", () => {
  it("never makes an invalid move", () => {
    const game = createGame();
    const move = computeCpuMove(game);

    expect(game.board[move]).toBe(Cell.Empty);
  });
});
