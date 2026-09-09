import type { RallarBlackBoxBrowserRallarRuntime } from '../../shared-test/rallar-bb-test/browser-adapter.ts';

type BrowserRallarAlmMethods = Pick<
    RallarBlackBoxBrowserRallarRuntime,
    | 'sendMessage'
    | 'observeDelivery'
    | 'cancelDelivery'
    | 'readReceipts'
    | 'injectFault'
    | 'readStorageCounters'
>;

/** Doubles that only drive connect, send, and health still owe the required ALM operations. */
export function createBrowserRallarAlmMethodsTestDouble(): BrowserRallarAlmMethods {
    const unsupported = (): Promise<never> => {
        return Promise.reject(
            new Error('This browser Rallar runtime double does not implement ALM operations.')
        );
    };
    return {
        sendMessage: unsupported,
        observeDelivery: unsupported,
        cancelDelivery: unsupported,
        readReceipts: unsupported,
        injectFault: unsupported,
        readStorageCounters: unsupported
    };
}
