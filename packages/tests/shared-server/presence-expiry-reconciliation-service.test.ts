import { describe, expect, it, vi } from 'vitest';
import {
    enqueuePresenceExpiryReconciliation,
} from '@shared-server/rallar-system/services/presence-expiry-reconciliation-service.ts';

describe('enqueuePresenceExpiryReconciliation', () => {
    it('enqueues client and group expiry scans without waiting for app inbox completion', async () => {
        const runtime = {
            appClientInboxService: {
                processExpiredSessionsNoWaiting: vi.fn(),
            },
            appGroupInboxService: {
                processExpiredPresenceSessionsNoWaiting: vi.fn(),
            },
        };

        enqueuePresenceExpiryReconciliation(runtime as never, 123_456);

        expect(
            runtime.appClientInboxService.processExpiredSessionsNoWaiting,
        ).toHaveBeenCalledWith(123_456);
        expect(
            runtime.appGroupInboxService
                .processExpiredPresenceSessionsNoWaiting,
        ).toHaveBeenCalledWith(123_456);
    });
});
