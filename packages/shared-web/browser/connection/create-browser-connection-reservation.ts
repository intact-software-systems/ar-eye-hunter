import type { BrowserTransportRuntime } from './browser-transport-runtime.ts';

/** One initialization owner's pending result, reserved before its synchronous setup ports run. */
export interface BrowserConnectionReservation {
    readonly promise: Promise<BrowserTransportRuntime.Connection>;
    settle(value: BrowserTransportRuntime.Connection | PromiseLike<BrowserTransportRuntime.Connection>): void;
}

export function createBrowserConnectionReservation(): BrowserConnectionReservation {
    let settle: BrowserConnectionReservation['settle'] | undefined;
    const promise = new Promise<BrowserTransportRuntime.Connection>((resolve) => {
        settle = resolve;
    });
    if (settle === undefined) {
        throw new Error('Browser connection promise did not install its settlement handle.');
    }
    return { promise, settle };
}
