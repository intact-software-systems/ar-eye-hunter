import { navigate, Route } from '../router.ts';
import { mustEl } from '../utils/utils.ts';

export class EhTictactoeLanding extends HTMLElement {
    connectedCallback(): void {
        this.render();
        this.wire();
    }

    private render(): void {
        this.innerHTML = `
      <div class="card">
        <h2>Choose mode</h2>
        <p class="muted">
          Single-player works offline. Two-player requires the server.
        </p>

        <div class="row">
          <button id="singleBtn">Single-player (offline)</button>
          <button id="multiBtn">Two-player (server)</button>
          <button id="p2pBtn">P2P-player (server)</button>
        </div>
      </div>
    `;
    }

    private wire(): void {
        const singleBtn = mustEl<HTMLButtonElement>(this, '#singleBtn');
        const multiBtn = mustEl<HTMLButtonElement>(this, '#multiBtn');
        const p2pBtn = mustEl<HTMLButtonElement>(this, '#p2pBtn');

        singleBtn.addEventListener('click', () => navigate(Route.Single));
        multiBtn.addEventListener('click', () => navigate(Route.Multi));
        p2pBtn.addEventListener('click', () => navigate(Route.P2P));
    }
}

customElements.define('eh-landing', EhTictactoeLanding);
