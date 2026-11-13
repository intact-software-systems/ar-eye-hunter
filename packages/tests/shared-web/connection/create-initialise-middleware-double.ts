import type { initialiseMiddleware } from '@shared-web/browser/connection/initialise-browser-middleware.ts';

/**
 * A double of `initialiseMiddleware` over the given fake connect that, as the real one does, waits for the publication
 * crypto the connect started. A double that drops it leaves the key work running after the test, warning once it ends.
 */
export function createInitialiseMiddlewareDouble(initialise: typeof initialiseMiddleware): typeof initialiseMiddleware {
    return async (session, rtcSignalingTopicId, options) => {
        const [connected] = await Promise.allSettled([
            initialise(session, rtcSignalingTopicId, options),
            options.publicationCrypto
        ]);
        if (connected.status === 'rejected') {
            throw connected.reason;
        }
        return connected.value;
    };
}
