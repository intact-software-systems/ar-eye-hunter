import '../../setup-browser-indexeddb.ts';

import { describe, expect, it } from 'vitest';

import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestBackendStores,
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SOURCE,
    type InboundTestStorage
} from './inbound-runtime-test-fixture.ts';

const AUDIENCE = ['sender', 'peer-b', 'peer-c'];

describe('inbound ingress audience read', () => {
    it.each<InboundTestStorage>(['memory', 'indexeddb'])(
        'answers the audience a WS client message was frozen to over the %s store, and nothing else',
        async (storage) => {
            const { stores } = createInboundTestBackendStores({
                namespace: `ingress-audience-${storage}`,
                storage,
                observer: createPassThroughIndexedDbOperationObserver()
            });
            const fixture = createInboundTestRuntime({
                stores,
                carrier: 'ws',
                effectWorkerId: `al-inbound:ingress-audience-${storage}`
            });
            await fixture.runtime.ready();
            const audienceMessage = createInboundTestMessage({ msgId: 'with-audience' });
            const plainMessage = createInboundTestMessage({ msgId: 'without-audience' });
            await fixture.runtime.admitIncomingMessage(audienceMessage, {
                ...INBOUND_TEST_SOURCE,
                groupRecipientPeerIds: AUDIENCE
            });
            await fixture.runtime.admitIncomingMessage(plainMessage, INBOUND_TEST_SOURCE);
            const { admissionStore } = stores;

            expect(await admissionStore.readIngressAudience('with-audience', 'sender')).toEqual(AUDIENCE);
            expect(await admissionStore.readIngressAudience('without-audience', 'sender')).toBeUndefined();
            expect(await admissionStore.readIngressAudience('unknown-message', 'sender')).toBeUndefined();
            expect(await admissionStore.readIngressAudience('with-audience', 'someone-else')).toBeUndefined();
        }
    );
});
