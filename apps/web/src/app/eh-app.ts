import {Route, getRouteFromHash} from './router.ts';

function mustEl<T extends HTMLElement>(root: ParentNode, selector: string): T {
    const el = root.querySelector(selector);
    if (!el) throw new Error(`Missing element: ${selector}`);
    return el as T;
}

export class EhApp extends HTMLElement {
    private currentRoute: Route = Route.Landing;

    connectedCallback(): void {
        window.addEventListener('hashchange', this.onHashChange);
        this.currentRoute = getRouteFromHash(location.hash);
        this.render();
    }

    disconnectedCallback(): void {
        window.removeEventListener('hashchange', this.onHashChange);
    }

    private onHashChange = (): void => {
        const next = getRouteFromHash(location.hash);
        if (next !== this.currentRoute) {
            this.currentRoute = next;
            this.render();
        }
    };

    private render(): void {
        this.innerHTML = `
      <div class="card">
        <div class="row">
          <strong>EyeHunter</strong>
          <span class="muted">/ Tic-Tac-Toe</span>
          <span style="margin-left:auto" class="muted">
            <a href="#/">Home</a>
          </span>
        </div>
      </div>

      <div id="screenHost"></div>
    `;

        const host = mustEl<HTMLDivElement>(this, '#screenHost');

        switch (this.currentRoute) {
            case Route.Single:
                host.innerHTML = `<eh-single-screen></eh-single-screen>`;
                return;

            case Route.Multi:
                host.innerHTML = `<eh-multi-screen></eh-multi-screen>`;
                return;

            case Route.Landing:
            default:
                host.innerHTML = `<eh-landing></eh-landing>`;
                return;
        }
    }
}

customElements.define('eh-app', EhApp);