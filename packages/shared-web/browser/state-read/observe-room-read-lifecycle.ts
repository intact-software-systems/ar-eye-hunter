import type { CreateBrowserRallarRoomsInput } from '../rooms/browser-rallar-rooms.ts';

/** Owns the page and socket transitions that suspend or resume room reads. */
export function observeRoomReadLifecycle(
    ws: CreateBrowserRallarRoomsInput['ws'], signal: AbortSignal, wake: () => void, suspend: () => void
): { isInactive(): boolean; } {
    let pageSuspended = false;
    let socketLost = !ws.status().isOpen;
    const resume = () => {
        pageSuspended = false;
        wake();
    };
    const hide = () => {
        pageSuspended = true;
        suspend();
    };
    const options = { signal };
    window.addEventListener('pagehide', hide, options);
    window.addEventListener('pageshow', resume, options);
    document.addEventListener('freeze', hide, options);
    document.addEventListener('resume', resume, options);
    document.addEventListener('visibilitychange', wake, options);
    window.addEventListener('offline', suspend, options);
    window.addEventListener('online', wake, options);
    const unsubscribe = ws.onLifecycle((event) => {
        socketLost = ['close', 'disconnected', 'error'].includes(event.kind);
        wake();
    }, { emitCurrent: false });
    signal.addEventListener('abort', unsubscribe, { once: true });
    return {
        isInactive: () => signal.aborted || pageSuspended || socketLost || document.visibilityState === 'hidden' || navigator.onLine === false
    };
}
