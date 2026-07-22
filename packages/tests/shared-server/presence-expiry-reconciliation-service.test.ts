import { describe, expect, it, vi } from 'vitest';
import {
    enqueuePresenceExpiryReconciliation,
} from '@shared-server/rallar-system/services/presence-expiry-reconciliation-service.ts';

describe('enqueuePresenceExpiryReconciliation', () => {
    it('enqueues client and group expiry through their app inboxes without waiting', async () => {
        const processExpiredPresenceSessionsNoWaiting = vi.fn(async () => 0);
        const runtime = {
            appClientInboxService: {
                processExpiredSessionsNoWaiting: vi.fn(),
            },
            appGroupInboxService: {
                processExpiredPresenceSessionsNoWaiting,
            },
        };

        enqueuePresenceExpiryReconciliation(runtime as never, 123_456);

        expect(
            runtime.appClientInboxService.processExpiredSessionsNoWaiting,
        ).toHaveBeenCalledWith(123_456);
        expect(
            processExpiredPresenceSessionsNoWaiting,
        ).toHaveBeenCalledWith(123_456);
    });

    it('does not invoke destructive group purge work', async () => {
        const processPurgeExpiredGroupsNoWaiting = vi.fn();
        const runtime = {
            appClientInboxService: {
                processExpiredSessionsNoWaiting: vi.fn(),
            },
            appGroupInboxService: {
                processExpiredPresenceSessionsNoWaiting: vi.fn(async () => 0),
                processPurgeExpiredGroupsNoWaiting,
            },
        };

        enqueuePresenceExpiryReconciliation(runtime as never, 123_456);

        expect(
            processPurgeExpiredGroupsNoWaiting,
        ).not.toHaveBeenCalled();
    });

    it('logs narrow maintenance failures instead of losing them silently', async () => {
        const failure = new Error('group expiry unavailable');
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const runtime = {
            appClientInboxService: {
                processExpiredSessionsNoWaiting: vi.fn(),
            },
            appGroupInboxService: {
                processExpiredPresenceSessionsNoWaiting: vi.fn(async () => {
                    throw failure;
                }),
            },
        };

        enqueuePresenceExpiryReconciliation(runtime as never, 123_456);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(error).toHaveBeenCalledWith(
            'Failed to reconcile expired group presence sessions:',
            failure,
        );
        error.mockRestore();
    });
});
