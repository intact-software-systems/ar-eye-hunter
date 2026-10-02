import { newALEventRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_RECEIPT_DEADLINE_GRACE_MS } from '@shared/al-contracts/al-control.ts';
import { resolveALMessageExpireAtMs, type ALDedupAlgo } from '@shared/al-contracts/al-policy.ts';
import { DEFAULT_AL_REPOSITORY_TTL_MS } from '@shared/alm/ALStoreRetention.ts';
import { computeALInboundDedupExpiryMs } from '@shared/alm/inbound/admission/al-inbound-delivery-mutations.ts';
import { describe, expect, it } from 'vitest';

const NOW_MS = 1_000_000;
const WINDOW_MS = 60_000;
/** The default message-owner lifetime, which caps the deadline term. */
const MSG_OWNER_TTL_MS = DEFAULT_AL_REPOSITORY_TTL_MS;

function computeExpiryMs(algo: ALDedupAlgo, messageDeadlineAtMs: number | undefined): number {
    return computeALInboundDedupExpiryMs({
        nowMs: NOW_MS,
        dedup: { algo, opts: { windowMs: WINDOW_MS } },
        messageDeadlineAtMs,
        msgOwnerTtlMs: MSG_OWNER_TTL_MS
    });
}

describe('computeALInboundDedupExpiryMs', () => {
    it.each<ALDedupAlgo>(['msg-id', 'msg-id+sender'])(
        'holds %s dedup through a deadline past the window plus the receipt grace',
        (algo) => {
            expect(computeExpiryMs(algo, NOW_MS + 120_000)).toBe(
                NOW_MS + 120_000 + AL_RECEIPT_DEADLINE_GRACE_MS
            );
        }
    );

    it('keeps the window as the floor when the deadline plus the grace ends first', () => {
        expect(computeExpiryMs('msg-id', NOW_MS + 10_000)).toBe(NOW_MS + WINDOW_MS);
    });

    it('keeps the window for a message that names no deadline', () => {
        expect(computeExpiryMs('msg-id', undefined)).toBe(NOW_MS + WINDOW_MS);
    });

    // A sender's deadline never sets the row's lifetime past the message-owner row's.
    it('caps the deadline term at the message-owner lifetime', () => {
        expect(computeExpiryMs('msg-id+sender', NOW_MS + 2 * MSG_OWNER_TTL_MS)).toBe(
            NOW_MS + MSG_OWNER_TTL_MS
        );
    });

    // The cap bounds only the deadline term: a message-owner lifetime shorter than the window keeps the window.
    it('keeps the window when the message-owner lifetime is shorter than it', () => {
        expect(computeALInboundDedupExpiryMs({
            nowMs: NOW_MS,
            dedup: { algo: 'msg-id', opts: { windowMs: WINDOW_MS } },
            messageDeadlineAtMs: NOW_MS + 120_000,
            msgOwnerTtlMs: WINDOW_MS / 2
        })).toBe(NOW_MS + WINDOW_MS);
    });

    it('keeps the window for the deadline a message with no hops left resolves to', () => {
        const message = newALUnicastMessage('sender', newALEventRoute('test', 'test'), 'receiver', 'test', {});
        const messageDeadlineAtMs = resolveALMessageExpireAtMs({ ...message, constraints: { ttlHops: 0 } });

        expect(computeExpiryMs('msg-id', messageDeadlineAtMs)).toBe(NOW_MS + WINDOW_MS);
    });

    // Stretching a semantic key to the deadline would drop new messages that share the key.
    it('keeps the window for semantic-key dedup whatever the deadline', () => {
        expect(computeExpiryMs('semantic-key', NOW_MS + 120_000)).toBe(NOW_MS + WINDOW_MS);
    });

    it('counts a negative window as none', () => {
        expect(computeALInboundDedupExpiryMs({
            nowMs: NOW_MS,
            dedup: { algo: 'semantic-key', opts: { windowMs: -1 } },
            messageDeadlineAtMs: undefined,
            msgOwnerTtlMs: MSG_OWNER_TTL_MS
        })).toBe(NOW_MS);
    });
});
