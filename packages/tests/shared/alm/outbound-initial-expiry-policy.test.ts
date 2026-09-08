import {
    describe,
    expect,
    it
} from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/al-policy.ts';
import { toALOutboundMessage } from '@shared/alm/outbound/to-al-outbound-message.ts';

describe('outbound first-admission expiry selection', () => {
    it('combines topic freshness with the independently supplied builder deadline', () => {
        const message = createMessage();
        const normalized = normalizeALQosPolicy(message, {
            defaults: { expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 500 } } }
        });
        const admitted = toALOutboundMessage(message, normalized.effective);

        expect(normalized.requested.expiry).toBeUndefined();
        expect(normalized.effective.expiry.algo).toBe('fresh-until');
        expect(admitted.constraints?.expiresAtMs).toBe(message.id.ts + 500);
        expect(message.constraints?.expiresAtMs).toBe(message.id.ts + 5_000);
        expect(normalized.notes).toContainEqual({
            aspect: 'expiry',
            kind: 'defaulted',
            reason: 'No explicit policy requested for aspect',
            effective: 'fresh-until'
        });
    });

    it('downgrades an unsupported topic default and retains the absolute envelope deadline', () => {
        const message = createMessage();
        const normalized = normalizeALQosPolicy(message, {
            defaults: { expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 500 } } },
            capabilities: { supportedExpiry: ['ttl-only'] }
        });
        const admitted = toALOutboundMessage(message, normalized.effective);

        expect(normalized.effective.expiry.algo).toBe('ttl-only');
        expect(admitted.constraints?.expiresAtMs).toBe(message.constraints?.expiresAtMs);
        expect(normalized.notes).toContainEqual({
            aspect: 'expiry',
            kind: 'downgraded',
            reason: 'Requested algorithm is not supported locally',
            requested: 'fresh-until',
            effective: 'ttl-only'
        });
    });

    it('allows an explicit message or input policy to replace a topic default within the envelope bound', () => {
        const message = createMessage();
        const requested = { ...message, qos: { expiry: { algo: 'expires-at' as const, opts: { expiresAtMs: message.id.ts + 2_000 } } } };
        const defaults = { expiry: { algo: 'fresh-until' as const, opts: { maxStalenessMs: 500 } } };
        const messagePolicy = normalizeALQosPolicy(requested, { defaults });
        const inputPolicy = normalizeALQosPolicy(requested, {
            defaults,
            request: { expiry: { algo: 'expires-at', opts: { expiresAtMs: message.id.ts + 10_000 } } }
        });

        expect(toALOutboundMessage(requested, messagePolicy.effective).constraints?.expiresAtMs).toBe(message.id.ts + 2_000);
        expect(toALOutboundMessage(requested, inputPolicy.effective).constraints?.expiresAtMs).toBe(message.id.ts + 5_000);
    });

    it('keeps the envelope hop count as a ceiling when topic defaults request more hops', () => {
        const message = createMessage();
        const normalized = normalizeALQosPolicy(message, {
            defaults: { expiry: { algo: 'ttl-only', opts: { ttlHops: 12 } } },
            capabilities: { maxTtlHops: 20 }
        });

        expect(normalized.effective.expiry.opts.ttlHops).toBe(3);
        expect(toALOutboundMessage(message, normalized.effective).constraints?.ttlHops).toBe(3);
    });
});

function createMessage() {
    const message = newALUnicastMessage('sender', { topicId: 'position', contextId: 'room', resourceId: 'player' }, 'receiver', 'position.v1', { x: 1 }, {
        ttlMs: 5_000
    });
    return { ...message, constraints: { ...message.constraints, ttlHops: 3 } };
}
