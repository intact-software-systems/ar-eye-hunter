import type {
    BrowserConnectedMiddleware,
    BrowserConnectOptions,
    initialiseMiddleware
} from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';

import { createInitialiseMiddlewareDouble } from './create-initialise-middleware-double.ts';

describe('createInitialiseMiddlewareDouble', () => {
    it('starts the fake connect only after the publication crypto settles, as the real initialiser does', async () => {
        const started: string[] = [];
        const crypto = Promise.withResolvers<PublicationCrypto>();

        const connected = createInitialiseMiddlewareDouble(recordConnect(started))(SESSION, 'rtc-topic', toOptions(crypto.promise));
        await Promise.resolve();
        expect(started).toEqual([]);

        crypto.resolve({} as PublicationCrypto);
        await connected;
        expect(started).toEqual(['rtc-topic']);
    });

    it('rejects the connect with the publication crypto failure, as the real initialiser does', async () => {
        const started: string[] = [];
        const failure = new Error('publication crypto unavailable');

        await expect(
            createInitialiseMiddlewareDouble(recordConnect(started))(SESSION, 'rtc-topic', toOptions(Promise.reject(failure)))
        ).rejects.toBe(failure);
        expect(started).toEqual([]);
    });
});

const SESSION = { sessionId: 'session-1' } as AuthSession;

function recordConnect(started: string[]): typeof initialiseMiddleware {
    return async (_session, rtcSignalingTopicId) => {
        started.push(rtcSignalingTopicId);
        return {} as BrowserConnectedMiddleware;
    };
}

function toOptions(publicationCrypto: Promise<PublicationCrypto>): BrowserConnectOptions {
    return { publicationCrypto } as BrowserConnectOptions;
}
