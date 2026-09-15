import type { RallarBlackBoxBrowserRallarRuntime } from '../../shared-test/rallar-bb-test/browser/browser-command-contracts.ts';

type BrowserRallarRequiredTestMethods = Pick<
    RallarBlackBoxBrowserRallarRuntime,
    | 'authenticate'
    | 'sendMessage'
    | 'observeDelivery'
    | 'cancelDelivery'
    | 'readReceipts'
    | 'injectFault'
    | 'readStorageCounters'
    | 'waitForRoom'
>;

/** Supplies required browser-runtime methods that a focused test does not exercise. */
export function createBrowserRallarRequiredMethodsTestDouble(): BrowserRallarRequiredTestMethods {
    const unsupported = (): Promise<never> => {
        return Promise.reject(
            new Error('This browser Rallar runtime double does not implement the requested operation.')
        );
    };
    return {
        authenticate: unsupported,
        sendMessage: unsupported,
        observeDelivery: unsupported,
        cancelDelivery: unsupported,
        readReceipts: unsupported,
        injectFault: unsupported,
        readStorageCounters: unsupported,
        waitForRoom: unsupported
    };
}
