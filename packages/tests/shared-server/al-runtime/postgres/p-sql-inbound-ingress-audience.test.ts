import { expect, it } from 'vitest';

import { createPSqlALInboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SENDER_PEER_ID,
    INBOUND_TEST_SOURCE
} from '../../../shared/alm/inbound-runtime-test-fixture.ts';
import { createPSqlAdmissionTestStorage } from './create-p-sql-admission-test-storage.ts';

it('answers the audience a WS client message was frozen to over PostgreSQL, and nothing else', async () => {
    const { repository } = await createPSqlAdmissionTestStorage();
    const stores = createPSqlALInboundRuntimeStores({
        nowMs: Date.now,
        repository,
        namespace: 'psql-ingress-audience',
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: undefined
    });
    const fixture = createInboundTestRuntime({
        stores,
        carrier: 'ws',
        effectWorkerId: 'al-inbound:psql-ingress-audience'
    });
    await fixture.runtime.ready();
    await fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'with-audience' }), {
        kind: 'ws-client',
        peerId: INBOUND_TEST_SENDER_PEER_ID,
        authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' },
        groupRecipientPeerIds: ['sender', 'peer-b']
    });
    await fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'without-audience' }), INBOUND_TEST_SOURCE);
    const { admissionStore } = stores;

    expect(await admissionStore.readIngressAudience('with-audience', 'sender')).toEqual(['sender', 'peer-b']);
    expect(await admissionStore.readIngressAudience('without-audience', 'sender')).toBeUndefined();
    expect(await admissionStore.readIngressAudience('unknown-message', 'sender')).toBeUndefined();
    expect(await admissionStore.readIngressAudience('with-audience', 'someone-else')).toBeUndefined();
});
