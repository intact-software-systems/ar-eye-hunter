import { enqueuePresenceExpiryReconciliation } from '@shared-server/rallar-system/group-state/presence/reconcile-expired-group-presence.ts';
import { describe, expect, it, vi } from 'vitest';

describe('enqueuePresenceExpiryReconciliation', () => {
    it('awaits durable client and group expiry enqueue through their app inboxes', async () => {
        const enqueueExpiredPresenceSessions = vi.fn(async () => 0);
        const runtime = {
            appClientInboxService: {
                enqueueExpiredSessions: vi.fn(async () => undefined)
            },
            groupStateInboxService: {
                enqueueExpiredPresenceSessions
            }
        };

        await enqueuePresenceExpiryReconciliation(runtime as never, 123_456);

        expect(runtime.appClientInboxService.enqueueExpiredSessions).toHaveBeenCalledWith(123_456);
        expect(enqueueExpiredPresenceSessions).toHaveBeenCalledWith(123_456);
    });

    it('propagates durable maintenance enqueue failures for interval retry', async () => {
        const failure = new Error('group expiry unavailable');
        const runtime = {
            appClientInboxService: {
                enqueueExpiredSessions: vi.fn(async () => undefined)
            },
            groupStateInboxService: {
                enqueueExpiredPresenceSessions: vi.fn(async () => {
                    throw failure;
                })
            }
        };

        await expect(enqueuePresenceExpiryReconciliation(runtime as never, 123_456)).rejects.toBe(
            failure
        );
        expect(runtime.appClientInboxService.enqueueExpiredSessions).toHaveBeenCalledWith(123_456);
    });
});
