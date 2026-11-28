import type { WsConnectionHolderLeaseReader } from '@shared-server/rallar-system/client-state/connection-holder/ws-connection-holder-lease.ts';

/** The holder a test's connects name when the test is not about which process holds a socket. */
export const TEST_WS_CONNECTION_HOLDER_ID = '00000000-0000-4000-8000-00000000c0de';

/** Every holder reads live: a test that does not name the fence keeps the meaning it had before the fence. */
export const LIVE_WS_CONNECTION_HOLDER_LEASES: WsConnectionHolderLeaseReader = {
    readHolderLease: async (holderId) => ({ holderId, live: true })
};
