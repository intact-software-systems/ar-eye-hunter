import { GAMES } from './games.ts';
import { mustEl } from './utils/utils.ts';

export class EhLandingScreen extends HTMLElement {
    connectedCallback(): void {
        this.render();
        this.wire();
    }

    private render(): void {
        const cards = GAMES.map((g) => {
            return `
        <button class="game-card" data-href="${g.href}">
          <div class="game-card__top">
            <div class="game-card__title">${g.title}</div>
            <div class="game-card__badge">${g.badge}</div>
          </div>
          <div class="game-card__desc">${g.description}</div>
        </button>
      `;
        }).join('');

        this.innerHTML = `
      <div class="card">
        <div class="row">
          <h2 style="margin:0;">Games</h2>
          <span style="margin-left:auto" class="muted">
            <a href="#/rooms">Rooms</a>
          </span>
        </div>
        <p class="muted">Choose a game to play.</p>

        <div class="game-grid">
          ${cards}
        </div>
      </div>
    `;
    }

    private wire(): void {
        const grid = mustEl<HTMLElement>(this, '.game-grid');
        grid.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            const btn = target.closest('button[data-href]') as HTMLButtonElement | null;
            if (!btn) return;
            const href = btn.dataset['href'];
            if (!href) return;
            location.hash = href;
        });
    }
}

customElements.define('eh-landing-screen', EhLandingScreen);
