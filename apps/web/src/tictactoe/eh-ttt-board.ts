import { Cell, GameResult, type GameState } from '@shared/mod.ts';

export interface CellClickDetail {
    index: number;
}

export class EhTttBoard extends HTMLElement {
    private _state: GameState | undefined;
    private _locked = true;

    set state(value: GameState) {
        this._state = value;
        this.render();
    }

    set locked(value: boolean) {
        this._locked = value;
        this.render();
    }

    connectedCallback(): void {
        this.render();
    }

    private render(): void {
        // If state not yet provided, render an empty board in a safe way
        const board: readonly Cell[] =
            this._state ? this._state.board : Array(9).fill(Cell.Empty);

        const gameActive =
            this._state ? this._state.result === GameResult.InProgress : false;

        const locked = this._locked || !gameActive;

        this.innerHTML = `
      <div class="board">
        ${board
            .map((cell, idx) => {
                const text = cell === Cell.Empty ? '' : cell;
                const disabled = locked || cell !== Cell.Empty;
                return `<button class="cell" data-idx="${idx}" ${disabled ? 'disabled' : ''}>${text}</button>`;
            })
            .join('')}
      </div>
    `;

        // Wire clicks
        this.querySelectorAll<HTMLButtonElement>('button.cell').forEach(btn => {
            btn.addEventListener('click', () => {
                const raw = btn.getAttribute('data-idx');
                const index = raw ? Number(raw) : -1;
                if (index >= 0 && index <= 8) {
                    this.dispatchEvent(
                        new CustomEvent<CellClickDetail>('cell-click', {
                            detail: { index },
                            bubbles: true
                        })
                    );
                }
            });
        });
    }
}

customElements.define('eh-ttt-board', EhTttBoard);
