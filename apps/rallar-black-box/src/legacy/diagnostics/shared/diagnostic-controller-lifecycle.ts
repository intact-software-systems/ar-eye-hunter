import { BrowserRallarSubscriptionScope } from '@shared-web/browser/messages/rallar-listener-delivery.ts';
import type { RallarSubscriptionScope } from '@shared-web/browser/rallar-shared-contracts.ts';
export namespace DiagnosticControllerLifecycle {
    export type Observation = 'observed' | 'timeout' | 'aborted';
    export interface WaitInput {
        hasObserved(): boolean;
        nowMs(): number;
        readonly startedAtEpochMs: number;
        readonly timeoutMs: number;
    }
}

/** Owns only this diagnostic component's acquisitions, never the shared Rallar transport. */
export class DiagnosticControllerLifecycle {
    private controller = new AbortController();
    private resources = new BrowserRallarSubscriptionScope();

    public get signal(): AbortSignal {
        return this.controller.signal;
    }

    public get subscriptions(): RallarSubscriptionScope {
        return this.resources;
    }

    public activate(): void {
        if (this.controller.signal.aborted) {
            this.controller = new AbortController();
            this.resources = new BrowserRallarSubscriptionScope();
        }
    }

    public close(): void {
        this.controller.abort();
        this.resources.unsubscribe();
    }

    public async waitForObservation(
        input: DiagnosticControllerLifecycle.WaitInput
    ): Promise<DiagnosticControllerLifecycle.Observation> {
        const signal = this.signal;
        if (signal.aborted) {
            return 'aborted';
        }
        return await new Promise<DiagnosticControllerLifecycle.Observation>((resolve) => {
            const owned = new BrowserRallarSubscriptionScope();
            owned.add(() => resolve('aborted'));
            const interval = window.setInterval(() => {
                if (input.hasObserved()) {
                    resolve('observed');
                    owned.unsubscribe();
                }
                else if (input.nowMs() - input.startedAtEpochMs > input.timeoutMs) {
                    resolve('timeout');
                    owned.unsubscribe();
                }
            }, 100);
            owned.add(() => window.clearInterval(interval));
            const abandon = () => owned.unsubscribe();
            signal.addEventListener('abort', abandon, { once: true });
            owned.add(() => signal.removeEventListener('abort', abandon));
        });
    }
}
