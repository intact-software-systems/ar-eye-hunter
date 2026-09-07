import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    normalizeALQosPolicy,
    planALMessageHandling,
    resolveALMessageExpireAtMs
} from '@shared/al-contracts/al-policy.ts';
import { describe, expect, it } from 'vitest';

const message: ALMessage = Object.freeze({
    id: Object.freeze({ v: 2, msgId: 'deadline-message', senderId: 'sender', ts: 1_000 }),
    route: Object.freeze({ topicId: 'chat', contextId: 'room', resourceId: 'message' }),
    payload: Object.freeze({ typeId: 'chat.v1', resource: '{}' }),
    delivery: Object.freeze({ reliability: 'at-least-once', ack: 'receiver' })
});

describe('AL message expiry', () => {
    it.each([
        { messageDeadline: 5_000, policyDeadline: 2_000, expected: 2_000 },
        { messageDeadline: 2_000, policyDeadline: 5_000, expected: 2_000 },
        { messageDeadline: undefined, policyDeadline: 2_000, expected: 2_000 },
        { messageDeadline: 2_000, policyDeadline: undefined, expected: 2_000 }
    ])('keeps the earliest envelope and effective policy deadline: $messageDeadline / $policyDeadline', ({ messageDeadline, policyDeadline, expected }) => {
        const msg = Object.freeze({ ...message, constraints: Object.freeze({ expiresAtMs: messageDeadline }) });
        const effective = Object.freeze({
            ...normalizeALQosPolicy(msg).effective,
            expiry: Object.freeze({ algo: 'expires-at' as const, opts: Object.freeze({ expiresAtMs: policyDeadline }) })
        });
        const before = structuredClone({ msg, effective });

        expect(resolveALMessageExpireAtMs(msg, effective)).toBe(expected);
        expect(resolveALMessageExpireAtMs(msg, effective)).toBe(expected);
        expect({ msg, effective }).toEqual(before);
    });

    it.each([
        { nowMs: 1_999, expired: false },
        { nowMs: 2_000, expired: true },
        { nowMs: 2_001, expired: true }
    ])('stops delivery and ACK obligations at the deadline: $nowMs', ({ nowMs, expired }) => {
        const msg: ALMessage = { ...message, constraints: { expiresAtMs: 2_000 } };
        const plan = planALMessageHandling(msg, { nowMs, selfPeerId: 'self', fromPeerId: 'sender' });

        expect(plan.dropReason).toBe(expired ? 'Message expired or is too stale' : undefined);
        expect(plan.localDelivery.enabled).toBe(!expired);
        expect(plan.ack.enabled).toBe(!expired);
        expect(plan.forwarding.enabled).toBe(false);
        expect(plan.repair.enabled).toBe(false);
        expect(plan.nack.reason).toBe(expired ? 'expired' : undefined);
    });

    it('applies an earlier normalized policy deadline before delivery or forwarding', () => {
        const msg: ALMessage = {
            ...message,
            targets: { mode: 'broadcast', scope: 'all' },
            constraints: { expiresAtMs: 10_000 },
            qos: { expiry: { algo: 'expires-at', opts: { expiresAtMs: 2_000 } } }
        };
        const context = { nowMs: 2_000, selfPeerId: 'self', fromPeerId: 'sender', overlayNeighborPeerIds: ['next'] };

        expect(planALMessageHandling(msg, { ...context, nowMs: 1_999 }).forwarding.enabled).toBe(true);
        const plan = planALMessageHandling(msg, context);
        expect(plan.dropReason).toBe('Message expired or is too stale');
        expect(plan.localDelivery.enabled).toBe(false);
        expect(plan.forwarding.enabled).toBe(false);
        expect(plan.ack.enabled).toBe(false);
        expect(plan.repair.enabled).toBe(false);
    });

    it('reads the message QoS deadline when no effective policy was supplied', () => {
        const msg: ALMessage = {
            ...message,
            constraints: { expiresAtMs: 10_000 },
            qos: { expiry: { algo: 'expires-at', opts: { expiresAtMs: 2_000 } } }
        };
        expect(resolveALMessageExpireAtMs(msg)).toBe(2_000);
    });

    it.each([
        { createdTs: undefined, expected: 1_500 },
        { createdTs: 800, expected: 1_300 }
    ])('anchors freshness to the original creation time: $createdTs', ({ createdTs, expected }) => {
        const msg: ALMessage = {
            ...message,
            audit: { createdTs },
            constraints: { expiresAtMs: 10_000 },
            qos: { expiry: { algo: 'fresh-until', opts: { expiresAtMs: 2_000, maxStalenessMs: 500 } } }
        };
        expect(resolveALMessageExpireAtMs(msg)).toBe(expected);
        expect(resolveALMessageExpireAtMs(msg, normalizeALQosPolicy(msg).effective)).toBe(expected);
    });

    it('does not extend an admitted deadline when the effective policy changes', () => {
        const msg: ALMessage = {
            ...message,
            constraints: { expiresAtMs: 2_000 },
            qos: { expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 1_000 } } }
        };
        const changed = normalizeALQosPolicy(msg, {
            request: { expiry: { algo: 'expires-at', opts: { expiresAtMs: 10_000 } } }
        }).effective;
        expect(resolveALMessageExpireAtMs(msg, changed)).toBe(2_000);
    });

    it('uses the selected effective policy instead of also enforcing the superseded QoS request', () => {
        const msg: ALMessage = {
            ...message,
            qos: { expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 500 } } }
        };
        const effective = normalizeALQosPolicy(msg, {
            request: { expiry: { algo: 'expires-at', opts: { expiresAtMs: 5_000 } } }
        }).effective;

        expect(resolveALMessageExpireAtMs(msg)).toBe(1_500);
        expect(resolveALMessageExpireAtMs(msg, effective)).toBe(5_000);
        expect(resolveALMessageExpireAtMs({ ...msg, constraints: { expiresAtMs: 2_000 } }, effective)).toBe(2_000);
    });

    it.each([
        { messageHops: 0, policyHops: 5 },
        { messageHops: 5, policyHops: 0 },
        { messageHops: undefined, policyHops: 0 }
    ])('expires when either applicable hop budget is exhausted: $messageHops / $policyHops', ({ messageHops, policyHops }) => {
        const msg: ALMessage = {
            ...message,
            constraints: { ttlHops: messageHops, expiresAtMs: 10_000 },
            qos: { expiry: { algo: 'ttl-only', opts: { ttlHops: policyHops } } }
        };
        expect(resolveALMessageExpireAtMs(msg)).toBe(0);
        const plan = planALMessageHandling(msg, { nowMs: 1_000, selfPeerId: 'self', fromPeerId: 'sender' });
        expect(plan.dropReason).toBe('Message expired or is too stale');
        expect(plan.localDelivery.enabled).toBe(false);
        expect(plan.ack.enabled).toBe(false);
    });

    it('does not turn a missing temporal constraint or an inactive freshness option into a delivery TTL', () => {
        const msg: ALMessage = {
            ...message,
            constraints: { ttlHops: 5 },
            qos: { expiry: { algo: 'ttl-only', opts: { maxStalenessMs: 500 } } }
        };
        expect(resolveALMessageExpireAtMs(message)).toBeUndefined();
        expect(resolveALMessageExpireAtMs(msg)).toBeUndefined();
        expect(resolveALMessageExpireAtMs(msg, normalizeALQosPolicy(msg).effective)).toBeUndefined();
    });
});
