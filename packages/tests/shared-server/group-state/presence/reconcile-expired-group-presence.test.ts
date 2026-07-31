import { describe, expect, it, vi } from 'vitest';
import { enqueuePresenceExpiryReconciliation as enqueueCompatibilityPresenceExpiryReconciliation } from '@shared-server/rallar-system/services/presence-expiry-reconciliation-service.ts';
import { enqueuePresenceExpiryReconciliation } from '@shared-server/rallar-system/group-state/presence/reconcile-expired-group-presence.ts';

describe('enqueuePresenceExpiryReconciliation', () => {
  it('keeps expiry reconciliation behind the stable one-hop public path', () => {
    expect(enqueueCompatibilityPresenceExpiryReconciliation).toBe(
      enqueuePresenceExpiryReconciliation,
    );
  });

  it('awaits durable client and group expiry enqueue through their app inboxes', async () => {
    const enqueueExpiredPresenceSessions = vi.fn(async () => 0);
    const runtime = {
      appClientInboxService: {
        enqueueExpiredSessions: vi.fn(async () => undefined),
      },
      appGroupInboxService: {
        enqueueExpiredPresenceSessions,
      },
    };

    await enqueuePresenceExpiryReconciliation(runtime as never, 123_456);

    expect(runtime.appClientInboxService.enqueueExpiredSessions).toHaveBeenCalledWith(123_456);
    expect(enqueueExpiredPresenceSessions).toHaveBeenCalledWith(123_456);
  });

  it('does not invoke destructive group purge work', async () => {
    const processPurgeExpiredGroupsNoWaiting = vi.fn();
    const runtime = {
      appClientInboxService: {
        enqueueExpiredSessions: vi.fn(async () => undefined),
      },
      appGroupInboxService: {
        enqueueExpiredPresenceSessions: vi.fn(async () => 0),
        processPurgeExpiredGroupsNoWaiting,
      },
    };

    await enqueuePresenceExpiryReconciliation(runtime as never, 123_456);

    expect(processPurgeExpiredGroupsNoWaiting).not.toHaveBeenCalled();
  });

  it('propagates durable maintenance enqueue failures for interval retry', async () => {
    const failure = new Error('group expiry unavailable');
    const runtime = {
      appClientInboxService: {
        enqueueExpiredSessions: vi.fn(async () => undefined),
      },
      appGroupInboxService: {
        enqueueExpiredPresenceSessions: vi.fn(async () => {
          throw failure;
        }),
      },
    };

    await expect(enqueuePresenceExpiryReconciliation(runtime as never, 123_456)).rejects.toBe(
      failure,
    );
    expect(runtime.appClientInboxService.enqueueExpiredSessions).toHaveBeenCalledWith(123_456);
  });
});
