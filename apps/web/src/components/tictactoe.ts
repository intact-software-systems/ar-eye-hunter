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

/* ------------------------------------------------------------------ */
/* State Factory                                                       */
/* ------------------------------------------------------------------ */

function createInitialState(mode: GameState["mode"]): GameState {
  return {
    board: Array(9).fill(Cell.Empty),
    currentPlayer: Player.X,
    result: GameResult.InProgress,
    mode,
  };
}

/* ------------------------------------------------------------------ */
/* Initial State                                                       */
/* ------------------------------------------------------------------ */

let state: GameState = createInitialState({
  type: GameModeType.Cpu,
  difficulty: CpuDifficulty.Easy,
});

/* ------------------------------------------------------------------ */
/* DOM Elements                                                        */
/* ------------------------------------------------------------------ */

const boardEl = document.getElementById("board") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const modeSelect = document.getElementById("modeSelect") as HTMLSelectElement;
const resetBtn = document.getElementById("resetBtn") as HTMLButtonElement;

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Event Handling                                                      */
/* ------------------------------------------------------------------ */

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
    state.mode.type === GameModeType.Cpu
  ) {
    const cpuMove = computeCpuMove(state);
    const cpuResult = applyMove(state, cpuMove);

    if (cpuResult.move === BoardMove.Succes) {
      state = cpuResult.output;
      render();
    }
  }
}

function parseMode(value: string): GameState["mode"] {
  switch (value) {
    case "CpuEasy":
      return { type: GameModeType.Cpu, difficulty: CpuDifficulty.Easy };
    case "CpuMedium":
      return { type: GameModeType.Cpu, difficulty: CpuDifficulty.Medium };
    case "CpuHard":
      return { type: GameModeType.Cpu, difficulty: CpuDifficulty.Hard };
    case "LocalHuman":
      return { type: GameModeType.LocalHuman, difficulty: CpuDifficulty.Hard };
    default:
      return { type: GameModeType.Cpu, difficulty: CpuDifficulty.Easy };
  }
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

modeSelect.addEventListener("change", () => {
  state = createInitialState(parseMode(modeSelect.value));
  render();
});

resetBtn.addEventListener("click", () => {
  state = createInitialState(state.mode);
  render();
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

render();
