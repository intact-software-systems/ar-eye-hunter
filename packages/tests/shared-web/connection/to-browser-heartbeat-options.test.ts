import { createDefaultBrowserSessionQosInputs } from '@shared-web/browser/composition/browser-session-composition.ts';
import { describe, expect, it } from 'vitest';

import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
import { configureBrowserALRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { BrowserALSessionChannel } from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import {
    createBrowserTransportInput,
    type BrowserConnectOptions,
    type BrowserTransportPublication
} from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { toBrowserHeartbeatOptions } from '@shared-web/browser/connection/to-browser-heartbeat-options.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupPresencePublicationKey } from '@shared/api/group-types.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';

import { NO_RTC_GRANTED_TOPICS } from '../../shared/multicast/rtc-granted-topic-reader-fixtures.ts';
import { KEYLESS_PUBLICATION_VERIFIER } from '../../shared/multicast/rtc-publication-proof-verifier-fixtures.ts';
import { NO_RTC_TOPIC_SUBSCRIPTIONS } from '../../shared/multicast/rtc-topic-subscription-reader-fixtures.ts';
import {
    createAvailablePublicationCryptoFixture,
    UNAVAILABLE_PUBLICATION_CRYPTO
} from '../../shared/signature/publication-crypto-fixtures.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

const SESSION: AuthSession = {
    clientId: 'client-1',
    sessionId: 'session-1',
    username: 'user',
    accessToken: 'test',
    expiresAtEpochMs: 60_000
};

const KEYLESS_PUBLICATION: BrowserTransportPublication = {
    publicationCrypto: UNAVAILABLE_PUBLICATION_CRYPTO,
    publicationVerifier: KEYLESS_PUBLICATION_VERIFIER
};

const OPTIONS: BrowserConnectOptions = {
    readIceCandidates: () => Promise.reject(new Error('No ICE read in a heartbeat translation.')),
    rtcCaptureConfiguration: { mode: 'off', origin: 'product-default' },
    ...createDefaultBrowserSessionQosInputs(),
    deliverySettlements: { ws: () => {}, rtc: () => {} },
    diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
    onResyncRequired: () => {},
    publicationCrypto: Promise.resolve(UNAVAILABLE_PUBLICATION_CRYPTO),
    publicationVerifier: KEYLESS_PUBLICATION_VERIFIER,
    grantedTopics: NO_RTC_GRANTED_TOPICS,
    topicSubscriptions: NO_RTC_TOPIC_SUBSCRIPTIONS,
    durableWorkOwnership: new BrowserALDurableWorkClaim({
        scope: defaultStateScope(),
        sessionId: SESSION.sessionId,
        locks: undefined,
        sessionChannel: new BrowserALSessionChannel({
            scope: defaultStateScope(),
            sessionId: SESSION.sessionId,
            instanceId: 'session-channel',
            openPort: () => undefined,
            applySettlement: () => {}
        })
    })
};

describe('the heartbeat options a connect hands its group heartbeats', () => {
    it('registers the public half of the page key the connect awaited', async () => {
        const publicationCrypto = await createAvailablePublicationCryptoFixture();

        expect(readHeartbeatPublicationKey(publicationCrypto)).toStrictEqual({
            keyId: publicationCrypto.keyPair.keyId,
            publicJwk: publicationCrypto.keyPair.publicJwk
        });
    });

    it('registers no key for a page without WebCrypto', () => {
        expect(readHeartbeatPublicationKey(UNAVAILABLE_PUBLICATION_CRYPTO)).toBeNull();
    });
});

function readHeartbeatPublicationKey(publicationCrypto: PublicationCrypto): GroupPresencePublicationKey | null {
    configureBrowserALRuntimeStores(SESSION.sessionId, { scope: defaultStateScope(), diagnosticsPorts: OPTIONS.diagnosticsPorts });
    const input = createBrowserTransportInput(SESSION, OPTIONS, { ...KEYLESS_PUBLICATION, publicationCrypto });
    const { ownWsConnectionGeneration } = createDefaultApiMiddlewareTestDouble().middleware;
    return toBrowserHeartbeatOptions(input, ownWsConnectionGeneration).publicationKey;
}
