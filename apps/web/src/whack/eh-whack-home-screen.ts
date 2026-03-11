import { navigate, Route } from '../router.ts';
import { mustEl } from '../utils/utils.ts';

export class EhWhackHomeScreen extends HTMLElement {
    connectedCallback(): void {
        this.innerHTML = `
      <div class="card">
        <h2>Whack-a-worm</h2>
        <p class="muted">Tap the worms before they disappear.</p>

        <div class="row">
          <button id="singleBtn">Single-player</button>
          <button id="backBtn">Back</button>
        </div>
      </div>
    `;

        const singleBtn = mustEl<HTMLButtonElement>(this, '#singleBtn');
        const backBtn = mustEl<HTMLButtonElement>(this, '#backBtn');

        singleBtn.addEventListener('click', () => navigate(Route.WhackSingle));
        backBtn.addEventListener('click', () => navigate(Route.Landing));
    }
}

customElements.define('eh-whack-home-screen', EhWhackHomeScreen);
