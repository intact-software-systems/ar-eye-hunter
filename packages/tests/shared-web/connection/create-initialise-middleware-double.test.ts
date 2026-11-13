import type {
    BrowserConnectedMiddleware,
    BrowserConnectOptions
} from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';

import { createInitialiseMiddlewareDouble } from './create-initialise-middleware-double.ts';

describe('createInitialiseMiddlewareDouble', () => {
    it('starts the fake connect only after the publication crypto settles, as the real initialiser does', async () => {
        const fake = vi.fn(async () => ({}) as BrowserConnectedMiddleware);
        const crypto = Promise.withResolvers<PublicationCrypto>();

        const connected = createInitialiseMiddlewareDouble(fake)(SESSION, 'rtc-topic', toOptions(crypto.promise));
        await Promise.resolve();
        expect(fake).not.toHaveBeenCalled();

        crypto.resolve({} as PublicationCrypto);
        await connected;
        expect(fake).toHaveBeenCalledOnce();
    });

    it('rejects the connect with the publication crypto failure, as the real initialiser does', async () => {
        const fake = vi.fn(async () => ({}) as BrowserConnectedMiddleware);
        const failure = new Error('publication crypto unavailable');

        await expect(
            createInitialiseMiddlewareDouble(fake)(SESSION, 'rtc-topic', toOptions(Promise.reject(failure)))
        ).rejects.toBe(failure);
        expect(fake).not.toHaveBeenCalled();
    });
});

const SESSION = { sessionId: 'session-1' } as AuthSession;

function toOptions(publicationCrypto: Promise<PublicationCrypto>): BrowserConnectOptions {
    return { publicationCrypto } as BrowserConnectOptions;
}
