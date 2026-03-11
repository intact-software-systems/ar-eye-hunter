import { describe, expect, it } from 'vitest';
import {
    COMPLETED_STATUSES,
    EntityStatus,
    FAILED_STATUS,
    isCompleted,
    isExpiredAudit,
    isFailed,
    isKeysEqual,
    NEVER_EXPIRE_TS,
    NEW_AND_RETRY_STATUSES,
    toKeyAsString,
    toResourceEntry,
    toResourceEntryKey,
    toResourceEntryWithKey,
    toUpdatedResourceEntry,
} from '@shared/queuebox/ResourceEntry.ts';

describe('ResourceEntry helpers', () => {
    it('round-trips queue keys through their string representation', () => {
        const key = {
            topicId: 'chat',
            resourceId: 'msg-1',
            contextId: 'room-1',
        };

        expect(toKeyAsString(key)).toBe('chat/msg-1/room-1');
        expect(toResourceEntryKey(toKeyAsString(key))).toEqual(key);
        expect(isKeysEqual(key, { ...key })).toBe(true);
        expect(
            isKeysEqual(key, {
                ...key,
                resourceId: 'msg-2',
            }),
        ).toBe(false);
    });

    it('creates updated entries without losing immutable entry fields', () => {
        const key = {
            topicId: 'presence',
            resourceId: 'alice',
            contextId: 'room-1',
        };
        const entry = toResourceEntryWithKey(key, 'presence.state.v1', {
            online: true,
        });
        const endTs = Temporal.Instant.from('2026-01-01T00:00:00Z');
        const nextTs = endTs.add({ seconds: 30 });

        const updated = toUpdatedResourceEntry(
            entry,
            EntityStatus.RETRY,
            endTs,
            nextTs,
        );

        expect(updated.key).toBe(entry.key);
        expect(updated.audit).toBe(entry.audit);
        expect(updated.resource).toBe(entry.resource);
        expect(updated.typeId).toBe(entry.typeId);
        expect(updated.status).toBe(EntityStatus.RETRY);
        expect(updated.dequeueAudit).toEqual({
            startTs: entry.dequeueAudit.startTs,
            endTs,
            nextTs,
            attempts: entry.dequeueAudit.attempts,
        });
    });

    it('classifies retryable, failed, and completed statuses consistently', () => {
        const entry = toResourceEntry('chat.message.v1', {
            text: 'hello',
        });

        expect(entry.status).toBe(EntityStatus.NEW);
        expect(NEW_AND_RETRY_STATUSES.has(EntityStatus.NEW)).toBe(true);
        expect(FAILED_STATUS.has(EntityStatus.FAILED)).toBe(true);
        expect(COMPLETED_STATUSES.has(EntityStatus.MERGED)).toBe(true);
        expect(isFailed(EntityStatus.NON_RETRYABLE)).toBe(true);
        expect(isFailed(EntityStatus.RESERVED)).toBe(false);
        expect(isCompleted(EntityStatus.COMPLETED)).toBe(true);
        expect(isCompleted(EntityStatus.RETRY)).toBe(false);
    });

    it('treats audit expiry as immutable queue metadata', () => {
        const expiredAt = Temporal.Instant.from('2026-01-01T00:00:00Z');
        const entry = toResourceEntry('chat.message.v1', { text: 'hello' }, expiredAt);

        expect(entry.audit.expiryTs).toBe(expiredAt);
        expect(isExpiredAudit({ ...entry.audit, expiryTs: expiredAt }, expiredAt)).toBe(true);
        expect(NEVER_EXPIRE_TS.epochMilliseconds).toBeGreaterThan(expiredAt.epochMilliseconds);
    });
});
