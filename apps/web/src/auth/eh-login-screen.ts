import {writeSession} from './auth.ts';
import {findHtmlEl, readNextFromHash} from "../utils/utils.ts";
import {loginToApi} from "../middleware/api-integration.ts";

export class EhLoginScreen extends HTMLElement {
    connectedCallback(): void {
        this.render();
        this.wire();
    }

    private render(): void {
        this.innerHTML = `
      <div class="card">
        <h2>Login</h2>
        <p class="muted">Sign in to continue.</p>

        <div class="row">
          <label>
            Username<br/>
            <input id="username" type="text" autocomplete="username" />
          </label>

          <label>
            Password<br/>
            <input id="password" type="password" autocomplete="current-password" />
          </label>

          <button id="loginBtn">Login</button>
        </div>

        <div id="status" class="status"></div>
      </div>
    `;
    }

    private wire(): void {
        const usernameEl = findHtmlEl(this, '#username');
        const passwordEl = findHtmlEl(this, '#password');
        const loginBtn = findHtmlEl(this, '#loginBtn');

        const submit = async (): Promise<void> => {
            this.setStatus('Logging in…');

            try {
                const username = usernameEl.value.trim();
                const password = passwordEl.value;

                if (username.length === 0 || password.length === 0) {
                    this.setStatus('Username and password are required.');
                    return;
                }

                const res = await loginToApi({username, password});

                writeSession({
                    clientId: res.clientId,
                    accessToken: res.accessToken,
                    username: res.username,
                });

                const next = readNextFromHash();
                location.hash = `#${next}`;
            } catch (e) {
                this.setStatus((e as Error).message);
            }
        };

        loginBtn.addEventListener('click', () => void submit());

        usernameEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') void submit();
        });

        passwordEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') void submit();
        });
    }

    private setStatus(text: string): void {
        const statusEl = findHtmlEl(this, '#status');
        statusEl.textContent = text;
    }
}

customElements.define('eh-login-screen', EhLoginScreen);