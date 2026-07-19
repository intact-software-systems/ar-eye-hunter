import { describe, expect, it, vi } from 'vitest';
import {
    enqueuePresenceExpiryReconciliation,
} from '@shared-server/rallar-system/services/presence-expiry-reconciliation-service.ts';

describe('enqueuePresenceExpiryReconciliation', () => {
    it('enqueues client expiry and invokes narrow group maintenance without waiting', async () => {
        const expireExpiredPresenceSessions = vi.fn(async () => []);
        const runtime = {
            appClientInboxService: {
                processExpiredSessionsNoWaiting: vi.fn(),
            },
            groupStateMaintenanceService: {
                disconnectPresenceSessionsBySessionId: vi.fn(async () => []),
                disconnectPresenceSessionsBySessionIdWritten: vi.fn(async () => []),
                expireExpiredPresenceSessions,
            },
        };

        enqueuePresenceExpiryReconciliation(runtime as never, 123_456);

        expect(
            runtime.appClientInboxService.processExpiredSessionsNoWaiting,
        ).toHaveBeenCalledWith(123_456);
        expect(
            expireExpiredPresenceSessions,
        ).toHaveBeenCalledWith(123_456);
    });

    it('does not invoke destructive group purge work', async () => {
        const processPurgeExpiredGroupsNoWaiting = vi.fn();
        const runtime = {
            appClientInboxService: {
                processExpiredSessionsNoWaiting: vi.fn(),
            },
            groupStateMaintenanceService: {
                disconnectPresenceSessionsBySessionId: vi.fn(async () => []),
                disconnectPresenceSessionsBySessionIdWritten: vi.fn(async () => []),
                expireExpiredPresenceSessions: vi.fn(async () => []),
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
            groupStateMaintenanceService: {
                disconnectPresenceSessionsBySessionId: vi.fn(async () => []),
                disconnectPresenceSessionsBySessionIdWritten: vi.fn(async () => []),
                expireExpiredPresenceSessions: vi.fn(async () => {
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
