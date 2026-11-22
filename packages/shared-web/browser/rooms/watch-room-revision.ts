import { notifyListener } from '../messages/rallar-listener-delivery.ts';
import type { RallarWsFacade } from '../rallar-realtime-facade.ts';

interface WatchRoomRevisionInput<T> {
    readonly signal?: AbortSignal;
    readonly ws: Pick<RallarWsFacade, 'onLifecycle' | 'status'>;
    onSessionEnd(stop: () => void): () => void;
    subscribe(changed: (revision: number) => void): () => void;
    read(signal: AbortSignal): Promise<T | null>;
    listener(observation: { status: 'current' | 'stale'; value: T | null; }): void;
    regresses(previous: T, next: T): boolean;
}

/** Socket events invalidate the durable read. A connected idle room generates no reads. */
export function watchRoomRevision<T extends { readonly revision: number; }>(input: WatchRoomRevisionInput<T>): () => void {
    input.signal?.throwIfAborted();
    const lifetime = new AbortController();
    const { signal } = lifetime;
    let request: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    let announcedRevision = 0;
    let pageSuspended = false;
    let socketLost = !input.ws.status().isOpen;
    let queued = false;
    let status: 'current' | 'stale' = 'stale';
    let observed: T | null = null;

    function publish(nextStatus: 'current' | 'stale', value = observed): void {
        if (signal.aborted || (status === nextStatus && observed?.revision === value?.revision)) {
            return;
        }
        status = nextStatus;
        observed = value;
        notifyListener(input.listener, { status: nextStatus, value });
    }
    function suspend(): void {
        clearTimeout(retry);
        request?.abort();
        request = undefined;
        queued = false;
        publish('stale');
    }
    async function refresh(): Promise<void> {
        clearTimeout(retry);
        const inactive = pageSuspended || socketLost || document.visibilityState === 'hidden' ||
            navigator.onLine === false;
        if (signal.aborted || inactive) {
            suspend();
            return;
        }
        if (request) {
            queued = true;
            return;
        }
        const attempt = new AbortController();
        request = attempt;
        let next: T | null;
        try {
            next = await input.read(AbortSignal.any([attempt.signal, AbortSignal.timeout(15_000)]));
            const previous = observed;
            if ((next?.revision ?? 0) < announcedRevision) {
                throw new Error('Room read predates the server notification.');
            }
            if (
                previous && (!next || next.revision < previous.revision ||
                    input.regresses(previous, next))
            ) {
                throw new Error('Room read regressed.');
            }
        }
        catch {
            if (request === attempt) {
                request = undefined;
                publish('stale');
                // One bounded retry burst per external wakeup, including when the server stays unavailable.
                if (!signal.aborted && retries < 3) {
                    retry = setTimeout(() => void refresh(), 1000 * 2 ** retries++);
                }
            }
            return;
        }
        if (request !== attempt) {
            return;
        }
        request = undefined;
        if (queued) {
            queued = false;
            void refresh();
            return;
        }
        publish('current', next);
    }
    function wake(): void {
        retries = 0;
        void refresh();
    }
    function resume(): void {
        pageSuspended = false;
        wake();
    }
    function hide(): void {
        pageSuspended = true;
        suspend();
    }
    const options = { signal };
    window.addEventListener('pagehide', hide, options);
    window.addEventListener('pageshow', resume, options);
    document.addEventListener('freeze', hide, options);
    document.addEventListener('resume', resume, options);
    document.addEventListener('visibilitychange', wake, options);
    window.addEventListener('offline', suspend, options);
    window.addEventListener('online', wake, options);
    const unsubscribeRoom = input.subscribe((revision) => {
        if (revision > Math.max(announcedRevision, observed?.revision ?? 0)) {
            announcedRevision = revision;
            publish('stale');
            wake();
        }
    });
    const unsubscribeSocket = input.ws.onLifecycle((event) => {
        socketLost = ['close', 'disconnected', 'error'].includes(event.kind);
        wake();
    }, { emitCurrent: false });
    const unsubscribeAuth = input.onSessionEnd(() => {
        try {
            publish('stale', null);
        }
        finally {
            dispose();
        }
    });
    function dispose(): void {
        lifetime.abort();
        suspend();
        unsubscribeAuth();
        unsubscribeRoom();
        unsubscribeSocket();
        input.signal?.removeEventListener('abort', dispose);
    }
    input.signal?.addEventListener('abort', dispose, { once: true });
    notifyListener(input.listener, { status: 'stale', value: null });
    wake();
    return dispose;
}
