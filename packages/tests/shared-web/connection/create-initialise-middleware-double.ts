import type { initialiseMiddleware } from '@shared-web/browser/connection/initialise-browser-middleware.ts';

/**
 * A double of `initialiseMiddleware` over the given fake connect that, in the real one's order, first waits for the
 * publication crypto the connect started, failing the connect if it rejects. A double that drops it leaves the key
 * work running after the test, warning once it ends.
 */
export function createInitialiseMiddlewareDouble(initialise: typeof initialiseMiddleware): typeof initialiseMiddleware {
    return async (session, rtcSignalingTopicId, options) => {
        await options.publicationCrypto;
        return await initialise(session, rtcSignalingTopicId, options);
    };
}
