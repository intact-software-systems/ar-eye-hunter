import type { ALCheckpointPort } from '@shared/alm/checkpoint/al-checkpoint.ts';
import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
import type { Unsubscribe } from '@shared/cache/RepositoryInterfaces.ts';

export interface BrowserPageLifecycleTarget {
    addEventListener(type: string, listener: () => void, options: AddEventListenerOptions): void;
}

export namespace BrowserPageLifecycleFlush {
    export interface Page {
        /** `visibilitychange` and `freeze` fire here; `undefined` outside a document. */
        readonly document:
            | (BrowserPageLifecycleTarget & Readonly<{ visibilityState: DocumentVisibilityState; }>)
            | undefined;
        /** `pagehide` fires here. */
        readonly window: BrowserPageLifecycleTarget | undefined;
    }

    export interface Input {
        readonly page: Page;
        readonly ownership: ALDurableWorkOwnership;
        /** The connect's checkpoints, one per outbound carrier, as the composition that built them hands them over. */
        readonly checkpoints: readonly Pick<ALCheckpointPort, 'flush'>[];
    }
}

/**
 * One connect's page-lifecycle listeners: a hidden, hidden-away or frozen page flushes the connect's
 * checkpoints, since a hidden page's timers are throttled and a frozen one runs none. They listen only
 * while the connect owns the session's work, the only connect whose checkpoints write, and `release()`
 * removes them. The flush is best effort: it starts the writes and awaits none.
 */
export class BrowserPageLifecycleFlush {
    private readonly input: BrowserPageLifecycleFlush.Input;
    private readonly lifetime = new AbortController();
    private readonly ownershipListener: Unsubscribe | undefined;
    private listening = false;

    constructor(input: BrowserPageLifecycleFlush.Input) {
        this.input = input;
        if (input.ownership.isOwned()) {
            this.listen();
        }
        else {
            this.ownershipListener = input.ownership.owned.onChangeDo(() => this.takeOver());
        }
    }

    release(): void {
        this.ownershipListener?.unsubscribe();
        this.lifetime.abort();
    }

    private takeOver(): void {
        if (!this.listening && !this.lifetime.signal.aborted && this.input.ownership.isOwned()) {
            this.listen();
        }
    }

    private listen(): void {
        this.listening = true;
        const { document, window } = this.input.page;
        const flush = () => this.input.checkpoints.forEach((checkpoint) => checkpoint.flush());
        const options: AddEventListenerOptions = { signal: this.lifetime.signal };
        document?.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                flush();
            }
        }, options);
        document?.addEventListener('freeze', flush, options);
        window?.addEventListener('pagehide', flush, options);
    }
}

export function readBrowserPageLifecycle(): BrowserPageLifecycleFlush.Page {
    return { document: globalThis.document, window: globalThis.window };
}
