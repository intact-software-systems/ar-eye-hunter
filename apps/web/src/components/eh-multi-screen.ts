export class EhMultiScreen extends HTMLElement {
    connectedCallback(): void {
        this.innerHTML = `
      <div class="card">
        <h2>Two-player (server)</h2>
        <p class="muted">
          This screen will use the shared contracts and the Deno API (create/join/move).
        </p>

        <div class="row">
          <button disabled>Create game</button>
          <button disabled>Join game</button>
        </div>

        <div class="muted">
          Next step: wire this screen to /api/games endpoints.
        </div>
      </div>
    `;
    }
}

customElements.define('eh-multi-screen', EhMultiScreen);
