import { Route, navigate } from '../app/router.ts';

export class EhLanding extends HTMLElement {
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
        const singleBtn = this.querySelector('#singleBtn');
        const multiBtn = this.querySelector('#multiBtn');
        const p2pBtn = this.querySelector('#p2pBtn');
        if (!singleBtn || !multiBtn || !p2pBtn) throw new Error('Landing buttons missing');

        singleBtn.addEventListener('click', () => navigate(Route.Single));
        multiBtn.addEventListener('click', () => navigate(Route.Multi));
        p2pBtn.addEventListener('click', () => navigate(Route.P2P));
    }
}

customElements.define('eh-landing', EhLanding);
