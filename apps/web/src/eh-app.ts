import {getRouteFromHash, Route} from './router.ts';
import {findHtmlEl} from './utils/utils.ts';
import {isLoggedIn} from './middleware/auth.ts';
import {initMiddleware, isMiddlewareReady} from "./app-context.ts";

export class EhApp extends HTMLElement {
    private currentRoute: Route = Route.Landing;

    async connectedCallback(): Promise<void> {
        self.window.addEventListener('hashchange', this.onHashChange);

        const next = getRouteFromHash(location.hash);
        if (!this.isPublicRoute(next)) {

            if (!isLoggedIn()) {
                this.redirectToLogin();
                this.currentRoute = Route.Login;
                this.render();
                return;
            }

            // after you confirm isLoggedIn()
            if (!isMiddlewareReady()) {
                await initMiddleware()
            }
        }


        this.currentRoute = next;
        this.render();
    }

    disconnectedCallback(): void {
        self.window.removeEventListener('hashchange', this.onHashChange);
    }

    private isPublicRoute(route: Route): boolean {
        return route === Route.Landing || route === Route.Login;
    }

    private getNextPathFromHash(hash: string): string {
        // hash like "#/login?next=%2Fp2p" or "#/multi"
        const raw = hash.startsWith('#') ? hash.slice(1) : hash;
        const qIndex = raw.indexOf('?');
        const path = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
        return path.length > 0 ? path : '/';
    }

    private redirectToLogin(): void {
        const nextPath = this.getNextPathFromHash(location.hash);
        const encoded = encodeURIComponent(nextPath);
        location.hash = `#/login?next=${encoded}`;
    }

    private onHashChange = async (): Promise<void> => {
        const next = getRouteFromHash(location.hash);

        // Route guard: if the user is not logged in, force login for protected routes.
        if (!this.isPublicRoute(next)) {

            if (!isLoggedIn()) {
                // Always rewrite the hash to include the intended next route.
                this.redirectToLogin();

                if (this.currentRoute !== Route.Login) {
                    this.currentRoute = Route.Login;
                    this.render();
                }

                return;
            }

            if (!isMiddlewareReady()) {
                await initMiddleware();
            }
        }

        if (next !== this.currentRoute) {
            this.currentRoute = next;
            this.render();
        }
    };

    private render(): void {
        this.innerHTML =
            `
              <div class="card">
                <div class="row">
                  <strong>EyeHunter</strong>
                  <span class="muted">/ Games</span>
                  <span style="margin-left:auto" class="muted">
                    <a href="#/">Home</a>
                  </span>
                </div>
              </div>
        
              <div id="screenHost"></div>
            `;

        const host = findHtmlEl<HTMLDivElement>(this, '#screenHost');

        switch (this.currentRoute) {
            case Route.TicTacToe:
                host.innerHTML = `<eh-landing></eh-landing>`;
                return;
            case Route.WhackAWorm:
                host.innerHTML = `<eh-whack-home-screen></eh-whack-home-screen>`;
                return;
            case Route.WhackSingle:
                host.innerHTML = `<eh-whack-single-screen></eh-whack-single-screen>`;
                return;
            case Route.Chat:
                host.innerHTML = `<chat-screen></chat-screen>`;
                return;
            case Route.Single:
                host.innerHTML = `<eh-single-screen></eh-single-screen>`;
                return;
            case Route.Multi:
                host.innerHTML = `<eh-multi-screen></eh-multi-screen>`;
                return;
            case Route.P2P:
                host.innerHTML = `<eh-p2p-multi-screen></eh-p2p-multi-screen>`;
                return;
            case Route.Login:
                host.innerHTML = `<eh-login-screen></eh-login-screen>`;
                return;
            case Route.Landing:
            default:
                host.innerHTML = `<eh-landing-screen></eh-landing-screen>`;
                return;
        }
    }
}

customElements.define('eh-app', EhApp);
