export class EhWhackAWormScreen extends HTMLElement {
    connectedCallback(): void {
        this.innerHTML = `
      <div class="card">
        <h2>Whack-a-worm</h2>
        <p class="muted">Coming soon.</p>
        <button id="backBtn">Back</button>
      </div>
    `;

        const btn = this.querySelector('#backBtn') as HTMLButtonElement | null;
        if (btn) btn.addEventListener('click', () => (location.hash = '#/'));
    }
}

customElements.define('eh-whack-screen', EhWhackAWormScreen);
