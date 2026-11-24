import type { TownMatchSession } from '../match/town-match-session.ts';

/** Opt-in support information stays in the guest tab. It never contains account, room or invitation identifiers. */
export class GuestConnectionDiagnostics {
    private readonly status = document.createElement('p');
    private readonly root: HTMLElement;
    private lastTick = 0;
    private lastClose = Number(sessionStorage.getItem('cca.trace.close'));
    private wasHidden = sessionStorage.getItem('cca.trace.hidden') === 'yes';
    private restored = sessionStorage.getItem('cca.trace.restored') === 'yes';

    constructor(root: HTMLElement, signal: AbortSignal) {
        this.root = root;
        this.status.setAttribute('role', 'status');
        this.status.setAttribute('aria-label', 'Connection diagnostics');
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.wasHidden = true;
                sessionStorage.setItem('cca.trace.hidden', 'yes');
            }
            else if (this.wasHidden) {
                this.restored = true;
                sessionStorage.setItem('cca.trace.restored', 'yes');
            }
            this.update();
        }, { signal });
    }

    closed(code: number | undefined): void {
        this.lastClose = code ?? 0;
        sessionStorage.setItem('cca.trace.close', String(this.lastClose));
        this.update();
    }

    display(view: TownMatchSession.View): void {
        if (view.match) this.lastTick = view.match.tick;
        if (view.interruption || view.match?.phase === 'interrupted') {
            this.show(this.root.querySelector('#round-results > div'));
        }
        else if (!view.match && this.lastClose) {
            this.show(this.root.querySelector('.online'));
        }
    }

    show(parent: Element | null): void {
        if (parent && this.status.parentElement !== parent) parent.append(this.status);
        this.update();
    }

    private update(): void {
        if (!this.status.isConnected) return;
        const text = `Last confirmed tick ${this.lastTick}. WebSocket close ${this.lastClose || 'unobserved'}. ` +
            `Page ${document.visibilityState}. Previously hidden ${this.wasHidden ? 'yes' : 'no'}. Restored ${this.restored ? 'yes' : 'no'}.`;
        if (this.status.textContent !== text) this.status.textContent = text;
    }
}
