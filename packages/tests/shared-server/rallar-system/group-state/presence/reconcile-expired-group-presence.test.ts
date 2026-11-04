import {
    enqueuePresenceExpiryReconciliation,
    startPresenceExpiryReconciliation
} from '@shared-server/rallar-system/group-state/presence/reconcile-expired-group-presence.ts';
import { toResourceEntry, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('enqueuePresenceExpiryReconciliation', () => {
    it('awaits durable client and group expiry enqueue through their app inboxes', async () => {
        const enqueueExpiredPresenceSessions = vi.fn(async () => 0);
        const runtime = {
            appClientInboxService: {
                enqueueExpiredSessions: vi.fn(async () => toResourceEntry('client.expire', { atEpochMs: 123456 }))
            },
            groupStateInboxService: {
                enqueueExpiredPresenceSessions
            }
        };

        await enqueuePresenceExpiryReconciliation(runtime, 123_456);

        expect(runtime.appClientInboxService.enqueueExpiredSessions).toHaveBeenCalledWith(123_456);
        expect(enqueueExpiredPresenceSessions).toHaveBeenCalledWith(123_456);
    });

    it('propagates durable maintenance enqueue failures for interval retry', async () => {
        const failure = new Error('group expiry unavailable');
        const runtime = {
            appClientInboxService: {
                enqueueExpiredSessions: vi.fn(async () => toResourceEntry('client.expire', { atEpochMs: 123456 }))
            },
            groupStateInboxService: {
                enqueueExpiredPresenceSessions: vi.fn(async () => {
                    throw failure;
                })
            }
        };

        await expect(enqueuePresenceExpiryReconciliation(runtime, 123_456)).rejects.toBe(
            failure
        );
        expect(runtime.appClientInboxService.enqueueExpiredSessions).toHaveBeenCalledWith(123_456);
    });
});

afterEach(() => vi.useRealTimers());

it('stops periodic expiry and drains enqueues before the database can close', async () => {
    vi.useFakeTimers();
    const held = Promise.withResolvers<ResourceEntry>();
    const client = vi.fn(() => held.promise);
    const group = vi.fn(async () => 0);
    const stop = startPresenceExpiryReconciliation({
        runtime: { appClientInboxService: { enqueueExpiredSessions: client }, groupStateInboxService: { enqueueExpiredPresenceSessions: group } },
        timers: createDefaultTimers(),
        intervalMs: 1000,
        nowEpochMs: () => 123456,
        onFailure: (error) => {
            throw error;
        }
    });
    let stopped = false;
    const stopping = stop().then(() => {
        stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    held.resolve(toResourceEntry('client.expire', { atEpochMs: 123456 }));
    await stopping;
    await stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(client).toHaveBeenCalledExactlyOnceWith(123456);
    expect(group).toHaveBeenCalledExactlyOnceWith(123456);
});

it('keeps shutdown pending until the sibling enqueue drains after one enqueue rejects', async () => {
    vi.useFakeTimers();
    const held = Promise.withResolvers<number>();
    const failure = new Error('client expiry failed');
    const failures: Error[] = [];
    const stop = startPresenceExpiryReconciliation({
        runtime: {
            appClientInboxService: {
                enqueueExpiredSessions: async () => {
                    throw failure;
                }
            },
            groupStateInboxService: { enqueueExpiredPresenceSessions: () => held.promise }
        },
        timers: createDefaultTimers(),
        intervalMs: 1000,
        nowEpochMs: () => 123456,
        onFailure: (error) => failures.push(error)
    });
    let stopped = false;
    const stopping = stop().then(() => {
        stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    held.resolve(0);
    await stopping;
    expect(failures).toEqual([failure]);
    await stop();
});
