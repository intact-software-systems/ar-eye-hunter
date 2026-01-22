import {
    BoardMove,
    Cell,
    CpuDifficulty,
    type GameMode,
    GameModeType,
    GameResult,
    type GameState,
    Player
} from '@shared/mod.ts';

import {applyMove, computeCpuMove} from '@shared/tictactoe/tictactoe.ts';
import type {CellClickDetail} from '../components/eh-ttt-board.ts';

function mustEl<T extends HTMLElement>(root: ParentNode, selector: string): T {
    const el = root.querySelector(selector);
    if (!el) throw new Error(`Missing element: ${selector}`);
    return el as T;
}

enum SingleModeUiValue {
    VsCpu = 'VsCpu',
    LocalHuman = 'LocalHuman'
}

function createInitialState(mode: GameMode): GameState {
    return {
        board: Array(9).fill(Cell.Empty),
        currentPlayer: Player.X,
        result: GameResult.InProgress,
        mode
    };
}

function modeFromUi(modeValue: string, difficultyValue: string): GameMode {
    switch (modeValue) {
        case SingleModeUiValue.LocalHuman:
            return {type: GameModeType.LocalHuman, difficulty: CpuDifficulty.Empty};

        case SingleModeUiValue.VsCpu:
        default:
            return {
                type: GameModeType.Cpu,
                difficulty: difficultyFromUi(difficultyValue)
            };
    }
}

function difficultyFromUi(value: string): CpuDifficulty {
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

export class EhSingleScreen extends HTMLElement {
    private state: GameState = createInitialState({
        type: GameModeType.Cpu,
        difficulty: CpuDifficulty.Easy
    });

    connectedCallback(): void {
        this.render();
        this.wire();
        this.updateView();
    }

    private render(): void {
        this.innerHTML = `
      <div class="card">
        <h2>Offline</h2>
        <p class="muted">Play without a server. Choose vs CPU or local two-player.</p>

        <div class="row">
          <label>
            Mode:
            <select id="modeSel">
              <option value="${SingleModeUiValue.VsCpu}">Vs CPU</option>
              <option value="${SingleModeUiValue.LocalHuman}">Local Human vs Human</option>
            </select>
          </label>

          <label id="diffWrap">
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
        const modeSel = mustEl<HTMLSelectElement>(this, '#modeSel');
        const diffSel = mustEl<HTMLSelectElement>(this, '#diffSel');
        const diffWrap = mustEl<HTMLLabelElement>(this, '#diffWrap');
        const resetBtn = mustEl<HTMLButtonElement>(this, '#resetBtn');
        const board = mustEl<HTMLElement>(this, '#board');

        const syncDiffVisibility = (): void => {
            const isCpu = modeSel.value === SingleModeUiValue.VsCpu;
            diffWrap.style.display = isCpu ? 'inline-block' : 'none';
        };

        syncDiffVisibility();

        modeSel.addEventListener('change', () => {
            syncDiffVisibility();
            const newMode = modeFromUi(modeSel.value, diffSel.value);
            this.state = createInitialState(newMode);
            this.updateView();
            this.maybeCpuMove();
        });

        diffSel.addEventListener('change', () => {
            if (modeSel.value !== SingleModeUiValue.VsCpu) {
                // Difficulty irrelevant for local-human mode
                return;
            }
            const newMode = modeFromUi(modeSel.value, diffSel.value);
            this.state = createInitialState(newMode);
            this.updateView();
            this.maybeCpuMove();
        });

        resetBtn.addEventListener('click', () => {
            // Preserve current mode on reset
            this.state = createInitialState(this.state.mode);
            this.updateView();
            this.maybeCpuMove();
        });

        board.addEventListener('cell-click', (e: Event) => {
            const ce = e as CustomEvent<CellClickDetail>;
            this.onHumanMove(ce.detail.index);
        });
    }

    private updateView(): void {
        const boardEl = mustEl<any>(this, '#board');
        const statusEl = mustEl<HTMLDivElement>(this, '#status');

        boardEl.state = this.state;

        const locked = this.state.result !== GameResult.InProgress;
        boardEl.locked = locked;

        statusEl.textContent = this.statusText();
    }

    private statusText(): string {
        switch (this.state.result) {
            case GameResult.InProgress:
                if (this.state.mode.type === GameModeType.Cpu) {
                    // In vs CPU: human is X, CPU is O (by convention)
                    return this.state.currentPlayer === Player.X
                        ? `Your turn (X).`
                        : `CPU thinking… (O)`;
                }
                // Local human vs human
                return `Turn: ${this.state.currentPlayer}`;

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

        // Vs CPU: only allow human to play X
        if (this.state.mode.type === GameModeType.Cpu && this.state.currentPlayer !== Player.X) {
            return;
        }

        const res = applyMove(this.state, index);
        if (res.move === BoardMove.Failed) return;

        this.state = res.output;
        this.updateView();
        this.maybeCpuMove();
    }

    private maybeCpuMove(): void {
        if (this.state.result !== GameResult.InProgress) return;
        if (this.state.mode.type !== GameModeType.Cpu) return;

        // Convention: CPU plays O
        if (this.state.currentPlayer !== Player.O) return;

        const cpuIndex = computeCpuMove(this.state);
        const cpuRes = applyMove(this.state, cpuIndex);

        if (cpuRes.move === BoardMove.Succes) {
            this.state = cpuRes.output;
            this.updateView();
        }
    }
}

customElements.define('eh-single-screen', EhSingleScreen);