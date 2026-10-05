import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';

/** One initialization owner's pending result, reserved before its synchronous setup ports run. */
export interface BrowserConnectionReservation {
    readonly promise: Promise<ApiMiddleware>;
    settle(value: ApiMiddleware | PromiseLike<ApiMiddleware>): void;
}

export function createBrowserConnectionReservation(): BrowserConnectionReservation {
    let settle: BrowserConnectionReservation['settle'] | undefined;
    const promise = new Promise<ApiMiddleware>((resolve) => {
        settle = resolve;
    });
    if (settle === undefined) {
        throw new Error('Browser connection promise did not install its settlement handle.');
    }
    return { promise, settle };
}
