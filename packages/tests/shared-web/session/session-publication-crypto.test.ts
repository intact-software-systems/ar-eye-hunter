import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import type { RallarSessionController } from '@shared-web/browser/session/rallar-session-controller.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';

import { NO_RTC_GRANTED_TOPICS } from '../../shared/multicast/rtc-granted-topic-reader-fixtures.ts';
import { KEYLESS_PUBLICATION_VERIFIER } from '../../shared/multicast/rtc-publication-proof-verifier-fixtures.ts';
import { NO_RTC_TOPIC_SUBSCRIPTIONS } from '../../shared/multicast/rtc-topic-subscription-reader-fixtures.ts';
import { InMemoryPublicationKeyStore } from '../../shared/signature/publication-key-store-fixtures.ts';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import { readAuthSessionContractMocks, resetAuthSessionContractMocks } from './browser-auth-session-contract-fixture.ts';

const mocks = readAuthSessionContractMocks();
installFakeBroadcastChannelPerTest();

beforeEach(async () => {
    await resetAuthSessionContractMocks();
    configureApiClient({ apiBaseUrl: 'https://api.example.test' });
});

describe('the publication key of the session a page is signed into', () => {
    it('gives two pages of one session the one stored public key', async () => {
        const store = new InMemoryPublicationKeyStore();
        const firstPage = await createSessionController(store);
        const secondPage = await createSessionController(store);

        const firstKey = await firstPage.readPublicationKey();

        expect(firstKey).not.toBeNull();
        expect(await secondPage.readPublicationKey()).toStrictEqual(firstKey);
        expect([...store.pairs.keys()]).toStrictEqual([mocks.ctx.session.sessionId]);
    });

    it('reads the key again when the page signs into another session', async () => {
        const store = new InMemoryPublicationKeyStore();
        const page = await createSessionController(store);
        const firstSessionKey = await page.readPublicationKey();

        mocks.readSession.mockReturnValue({ ...mocks.ctx.session, sessionId: 'session-2' });
        const secondSessionKey = await page.readPublicationKey();

        expect(secondSessionKey?.keyId).not.toBe(firstSessionKey?.keyId);
        expect(secondSessionKey?.keyId).toBe(store.pairs.get('session-2')?.keyId);
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        expect(await page.readPublicationKey()).toStrictEqual(firstSessionKey);
    });

    it('hands each connect the key of the session it connects', async () => {
        const store = new InMemoryPublicationKeyStore();
        const page = await createSessionController(store);
        onTestFinished(() => page.disconnect());

        await page.connect();

        const options = mocks.initialiseMiddleware.mock.calls[0]?.[2];
        expect(options?.publicationCrypto).toBeDefined();
        expect(toGroupPresencePublicationKey(await options!.publicationCrypto)).toStrictEqual(
            await page.readPublicationKey()
        );
        expect([...store.pairs.keys()]).toStrictEqual([mocks.ctx.session.sessionId]);
    });
});

/** A page's session controller over its own runtime foundation and the browser's one key store. */
async function createSessionController(store: InMemoryPublicationKeyStore): Promise<RallarSessionController> {
    const { createBrowserRuntimeFoundation } = await import('@shared-web/browser/composition/browser-runtime-composition.ts');
    const { browserDeliveryComposition } = await import('@shared-web/browser/composition/browser-delivery-composition.ts');
    const { BrowserSessionDeliveries } = await import('@shared-web/browser/messages/browser-session-deliveries.ts');
    const { createRallarSessionController } = await import('@shared-web/browser/session/rallar-session-controller.ts');
    const foundation = createBrowserRuntimeFoundation();
    return createRallarSessionController({
        qosProvider: undefined,
        readVolatileSessionLimits: undefined,
        readPublicationStageLimits: undefined,
        sessionDeliveries: new BrowserSessionDeliveries(
            browserDeliveryComposition.deliveries,
            foundation.transportRuntime,
            mocks.readSession
        ),
        onResyncRequired: () => {},
        subtle: globalThis.crypto.subtle,
        publicationKeyStore: store,
        publicationVerifier: Promise.resolve(KEYLESS_PUBLICATION_VERIFIER),
        grantedTopics: NO_RTC_GRANTED_TOPICS,
        topicSubscriptions: NO_RTC_TOPIC_SUBSCRIPTIONS,
        connectionRuntime: foundation.connectionRuntime,
        transportRuntime: foundation.transportRuntime,
        authRuntime: foundation.authRuntime,
        stateRuntime: foundation.runtime,
        lifecycle: foundation.lifecycle,
        emitState: () => {},
        closeDataScopes: async () => {}
    });
}
