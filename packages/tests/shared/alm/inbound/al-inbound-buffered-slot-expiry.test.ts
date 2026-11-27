import 'fake-indexeddb/auto';

import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import { createInboundTestBackendStores, type InboundTestStorage } from '../inbound-runtime-test-fixture.ts';
import { describeALInboundBufferedSlotExpiryContract } from './al-inbound-buffered-slot-expiry-contract.ts';

// Memory writes queue one behind another, so no other writer runs inside a commit; an IndexedDB commit's read reaches
// the store as it is then.
const COMMIT_SLOT_REREADS = { memory: 'serialized', indexeddb: 'store' } as const satisfies Record<InboundTestStorage, string>;

for (const storage of ['memory', 'indexeddb'] satisfies readonly InboundTestStorage[]) {
    describeALInboundBufferedSlotExpiryContract({
        label: storage,
        createStores: async (namespace) => createInboundTestBackendStores({ namespace, storage, observer: createPassThroughIndexedDbOperationObserver() }),
        commitSlotReread: COMMIT_SLOT_REREADS[storage]
    });
}
