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

        const singleBtn = this.querySelector('#singleBtn') as HTMLButtonElement | null;
        const backBtn = this.querySelector('#backBtn') as HTMLButtonElement | null;

        if (!singleBtn) throw new Error('Missing #singleBtn');
        if (!backBtn) throw new Error('Missing #backBtn');

        singleBtn.addEventListener('click', () => (location.hash = '#/whackaworm/single'));
        backBtn.addEventListener('click', () => (location.hash = '#/'));
    }
}

customElements.define('eh-whack-home-screen', EhWhackHomeScreen);