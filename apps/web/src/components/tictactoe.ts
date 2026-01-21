import { applyMove, computeCpuMove } from "@shared/game/tictactoe.ts";

import {
  BoardMove,
  Cell,
  CpuDifficulty,
  GameModeType,
  GameResult,
  type GameState,
  Player,
} from "@shared/game/tictactoe.ts";

let state: GameState = {
  board: Array(9).fill(Cell.Empty),
  currentPlayer: Player.X,
  result: GameResult.InProgress,
  mode: {
    type: GameModeType.Cpu,
    difficulty: CpuDifficulty.Easy,
  },
};

const boardEl = document.getElementById("board") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

function render(): void {
  boardEl.innerHTML = "";

  state.board.forEach((cell, index) => {
    const button = document.createElement("button");
    button.className = "cell";
    button.textContent = cell === Cell.Empty ? "" : cell;

    button.disabled = cell !== Cell.Empty ||
      state.result !== GameResult.InProgress;

    button.addEventListener("click", () => onCellClick(index));

    boardEl.appendChild(button);
  });

  statusEl.textContent = statusText();
}

function statusText(): string {
  switch (state.result) {
    case GameResult.InProgress:
      return `Current player: ${state.currentPlayer}`;
    case GameResult.XWins:
      return "Player X wins!";
    case GameResult.OWins:
      return "Player O wins!";
    case GameResult.Draw:
      return "Draw!";
  }
}

function onCellClick(index: number): void {
  const humanResult = applyMove(state, index);

  if (humanResult.move !== BoardMove.Succes) {
    return;
  }

  state = humanResult.output;
  render();

  // CPU turn
  if (
    state.result === GameResult.InProgress &&
    state.mode.type === GameModeType.Cpu &&
    state.currentPlayer !== Player.NA
  ) {
    const cpuMove = computeCpuMove(state);

    const cpuResult = applyMove(state, cpuMove);

    if (cpuResult.move === BoardMove.Succes) {
      state = cpuResult.output;
      render();
    }
  }
}

render();
