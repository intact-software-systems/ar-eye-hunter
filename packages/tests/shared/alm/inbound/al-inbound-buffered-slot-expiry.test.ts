import 'fake-indexeddb/auto';

import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import { createInboundTestBackendStores, type InboundTestStorage } from '../inbound-runtime-test-fixture.ts';
import { describeALInboundBufferedSlotExpiryContract } from './al-inbound-buffered-slot-expiry-contract.ts';

for (const storage of ['memory', 'indexeddb'] satisfies readonly InboundTestStorage[]) {
    describeALInboundBufferedSlotExpiryContract(
        storage,
        async (namespace) => createInboundTestBackendStores({ namespace, storage, observer: createPassThroughIndexedDbOperationObserver() })
    );
}
