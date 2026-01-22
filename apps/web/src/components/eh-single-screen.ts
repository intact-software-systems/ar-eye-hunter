import {
    BoardMove,
    CpuDifficulty,
    GameModeType,
    GameResult,
    Player,
    Cell,
    type GameState
} from '@shared/mod.ts';

import { applyMove, computeCpuMove } from '@shared/tictactoe/tictactoe.ts';
import type { CellClickDetail } from './eh-ttt-board.ts';

function createSingleState(difficulty: CpuDifficulty): GameState {
    return {
        board: Array(9).fill(Cell.Empty),
        currentPlayer: Player.X,
        result: GameResult.InProgress,
        mode: { type: GameModeType.Cpu, difficulty }
    };
}

export class EhSingleScreen extends HTMLElement {
    private state: GameState = createSingleState(CpuDifficulty.Easy);

    connectedCallback(): void {
        this.render();
        this.wire();
        this.updateBoard();
    }

    private render(): void {
        this.innerHTML = `
      <div class="card">
        <h2>Single-player (offline)</h2>

        <div class="row">
          <label>
            Difficulty:
            <select id="diffSel">
              <option value="Easy">Easy</option>
              <option value="Medium">Medium</option>
              <option value="Hard">Hard</option>
            </select>
          </label>

          <button id="resetBtn">Reset</button>
        </div>

        <eh-ttt-board id="board"></eh-ttt-board>
        <div id="status" class="status"></div>
      </div>
    `;
    }

    private wire(): void {
        const diffSel = this.querySelector('#diffSel') as HTMLSelectElement;
        const resetBtn = this.querySelector('#resetBtn') as HTMLButtonElement;
        const board = this.querySelector('#board') as HTMLElement;

        if (!diffSel || !resetBtn || !board) throw new Error('Single screen elements missing');

        diffSel.addEventListener('change', () => {
            const difficulty = this.parseDifficulty(diffSel.value);
            this.state = createSingleState(difficulty);
            this.updateBoard();
        });

        resetBtn.addEventListener('click', () => {
            const difficulty =
                this.state.mode.type === GameModeType.Cpu
                    ? this.state.mode.difficulty
                    : CpuDifficulty.Easy;

            this.state = createSingleState(difficulty);
            this.updateBoard();
        });

        board.addEventListener('cell-click', (e: Event) => {
            const ce = e as CustomEvent<CellClickDetail>;
            this.onHumanMove(ce.detail.index);
        });
    }

    private parseDifficulty(value: string): CpuDifficulty {
        switch (value) {
            case 'Hard':
                return CpuDifficulty.Hard;
            case 'Medium':
                return CpuDifficulty.Medium;
            case 'Easy':
            default:
                return CpuDifficulty.Easy;
        }
    }

    private updateBoard(): void {
        const boardEl = this.querySelector('#board') as any;
        const statusEl = this.querySelector('#status') as HTMLDivElement;

        if (!boardEl || !statusEl) throw new Error('Single screen missing board/status');

        boardEl.state = this.state;
        boardEl.locked = this.state.result !== GameResult.InProgress;

        statusEl.textContent = this.statusText();
    }

    private statusText(): string {
        switch (this.state.result) {
            case GameResult.InProgress:
                return `Turn: ${this.state.currentPlayer} (you are X)`;
            case GameResult.XWins:
                return 'Game over: X wins!';
            case GameResult.OWins:
                return 'Game over: O wins!';
            case GameResult.Draw:
                return 'Game over: Draw!';
        }
    }

    private onHumanMove(index: number): void {
        if (this.state.result !== GameResult.InProgress) return;
        if (this.state.currentPlayer !== Player.X) return; // single-player: human is X

        const res = applyMove(this.state, index);
        if (res.move === BoardMove.Failed) return;

        this.state = res.output;
        this.updateBoard();

        // CPU responds
        if (this.state.result === GameResult.InProgress && this.state.currentPlayer === Player.O) {
            const cpuMove = computeCpuMove(this.state);
            const cpuRes = applyMove(this.state, cpuMove);
            if (cpuRes.move === BoardMove.Succes) {
                this.state = cpuRes.output;
                this.updateBoard();
            }
        }
    }
}

customElements.define('eh-single-screen', EhSingleScreen);
