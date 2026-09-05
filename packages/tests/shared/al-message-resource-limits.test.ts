import {
    describe,
    expect,
    it
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    decodeALMessage,
    decodeALMessageValue,
    decodePersistedALMessage,
    decodePersistedALMessageValue
} from '@shared/al-contracts/al-message-persistence-validation.ts';
import { validateALMessageResourceLimits, validateSerializedALMessageSize } from '@shared/al-contracts/al-message-resource-limits.ts';

describe('AL envelope resource limits', () => {
    it('reports malformed, oversized, and unsupported envelopes as typed rejections', () => {
        const message = messageFixture();
        const unsupported = { ...message, id: { ...message.id, v: 3 } };

        expect(decodeALMessage('{').left?.code).toBe('malformed');
        expect(decodeALMessageValue({ route: message.route }).left?.code).toBe('malformed');
        expect(decodeALMessageValue(unsupported).left?.code).toBe('unsupported');
        expect(decodeALMessage(' '.repeat(131073)).left?.code).toBe('oversized');
        expect(decodeALMessageValue(message).right).toEqual(message);
    });

    it.each(['topicId', 'contextId', 'resourceId'] as const)('bounds route %s at 128 characters', (field) => {
        const message = messageFixture();
        const allowed = { ...message, route: { ...message.route, [field]: 'r'.repeat(128) } };
        const excessive = { ...message, route: { ...message.route, [field]: 'r'.repeat(129) } };

        expect(decodePersistedALMessageValue(allowed).route[field]).toHaveLength(128);
        expect(() => decodePersistedALMessageValue(excessive)).toThrow(/route.*limit/i);
    });

    it('measures the JSON payload ceiling in UTF-8 bytes', () => {
        const message = messageFixture();
        const allowed = { ...message, payload: { ...message.payload, resource: JSON.stringify('é'.repeat(32767)) } };
        const excessive = { ...message, payload: { ...message.payload, resource: JSON.stringify('é'.repeat(32768)) } };

        expect(decodePersistedALMessageValue(allowed).payload.resource).toBe(allowed.payload.resource);
        expect(() => decodePersistedALMessageValue(excessive)).toThrow(/payload.*limit/i);
        expect(() => decodePersistedALMessage(JSON.stringify(excessive))).toThrow(/payload.*limit/i);
    });

    it.each(['{', 'undefined', '{"broken":}'])('rejects invalid payload JSON: %s', (resource) => {
        const message = messageFixture();
        expect(() => decodePersistedALMessageValue({ ...message, payload: { ...message.payload, resource } }))
            .toThrow(/payload.*JSON/i);
    });

    it('bounds the whole envelope even when each payload and collection is individually allowed', () => {
        const message = messageFixture();
        const excessive = {
            ...message,
            payload: { ...message.payload, resource: JSON.stringify('p'.repeat(60000)) },
            forwarding: { nextHopPeerIds: Array.from({ length: 256 }, (_, index) => `${index}:${'n'.repeat(400)}`) }
        };

        expect(() => decodePersistedALMessageValue(excessive)).toThrow(/envelope.*limit/i);
        expect(() => decodePersistedALMessage(JSON.stringify(excessive))).toThrow(/envelope.*limit/i);
    });

    it('bounds protocol collections before traversing their entries', () => {
        const message = messageFixture();
        const allowed = { ...message, forwarding: { nextHopPeerIds: Array.from({ length: 256 }, (_, index) => `p-${index}`) } };
        const excessivePeers = new Array(1_000_000);
        let elementRead = false;
        Object.defineProperty(excessivePeers, '0', {
            enumerable: true,
            get: () => {
                elementRead = true;
                return 'peer';
            }
        });

        expect(decodePersistedALMessageValue(allowed).forwarding?.nextHopPeerIds).toHaveLength(256);
        expect(() => decodePersistedALMessageValue({ ...message, forwarding: { nextHopPeerIds: excessivePeers } }))
            .toThrow(/collection.*limit/i);
        expect(elementRead).toBe(false);
    });

    it('bounds visited peers and remaining hops independently', () => {
        const message = messageFixture();
        const allowed = {
            ...message,
            diagnostics: { visitedPeerIds: Array.from({ length: 64 }, (_, index) => `p-${index}`) },
            constraints: { ttlHops: 64 }
        };

        expect(decodePersistedALMessageValue(allowed).constraints?.ttlHops).toBe(64);
        expect(() => decodePersistedALMessageValue({ ...allowed, constraints: { ttlHops: 65 } })).toThrow(/hop.*limit/i);
        expect(() =>
            decodePersistedALMessageValue({
                ...allowed,
                diagnostics: { visitedPeerIds: [...allowed.diagnostics.visitedPeerIds, 'extra-peer'] }
            })
        ).toThrow(/visited.*limit/i);
    });

    it('does not invoke getters or serialization hooks while measuring untrusted objects', () => {
        let customBehaviorRan = false;
        const message = messageFixture();
        Object.defineProperty(message, 'toJSON', {
            enumerable: true,
            get: () => {
                customBehaviorRan = true;
                return () => ({});
            }
        });

        expect(() => decodePersistedALMessageValue(message)).toThrow();
        expect(customBehaviorRan).toBe(false);
    });

    it.each([
        { peers: new Array(2) },
        { peers: Object.assign(['peer'], { extra: 'hidden-on-wire' }) },
        { peers: Object.assign(new Array(2), { 1: 'peer' }) },
        { peers: Object.assign(['peer'], { '01': 'not-an-index' }) }
    ])('rejects sparse or decorated protocol arrays', ({ peers }) => {
        const message = { ...messageFixture(), forwarding: { nextHopPeerIds: peers } };

        expect(validateALMessageResourceLimits(message)[0]?.code).toBe('malformed');
    });

    it('rejects array accessors without executing them', () => {
        const peers = ['peer'];
        let getterInvoked = false;
        Object.defineProperty(peers, '0', {
            enumerable: true,
            get: () => {
                getterInvoked = true;
                return 'peer';
            }
        });

        expect(validateALMessageResourceLimits({ forwarding: { nextHopPeerIds: peers } })[0]?.code).toBe('malformed');
        expect(getterInvoked).toBe(false);
    });

    it('does not invoke a data-property toJSON function', () => {
        let hookInvoked = false;
        const value = {
            toJSON: () => {
                hookInvoked = true;
                return {};
            }
        };

        expect(validateALMessageResourceLimits(value)[0]?.code).toBe('malformed');
        expect(hookInvoked).toBe(false);
    });

    it('rejects cycles while counting harmless shared values for each wire occurrence', () => {
        const shared = { label: 'safe' };
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;

        expect(validateALMessageResourceLimits({ left: shared, right: shared })).toEqual([]);
        expect(validateALMessageResourceLimits(cycle)[0]?.code).toBe('malformed');
        const largeShared = { label: 'p'.repeat(66000) };
        expect(validateALMessageResourceLimits({ left: largeShared, right: largeShared })[0]?.code).toBe('oversized');
    });

    it('bounds expanded alias trees and deeply nested values without recursion', () => {
        let deep: unknown = null;
        for (let level = 0; level < 20000; level++) {
            deep = [deep];
        }
        expect(validateALMessageResourceLimits(deep)).toEqual([]);
        for (let level = 0; level < 50000; level++) {
            deep = [deep];
        }
        expect(validateALMessageResourceLimits(deep)[0]?.code).toBe('oversized');

        let aliases: unknown = null;
        for (let level = 0; level < 24; level++) {
            aliases = [aliases, aliases];
        }
        expect(validateALMessageResourceLimits(aliases)[0]?.code).toBe('oversized');
    });

    it.each(['é', '😀', '\ud800', '\udfff', '\\', '"', '\n', '\u0000', '\b', '\t', '\u2028'])(
        'counts exact UTF-8 JSON bytes for %j at the envelope boundary',
        (character) => {
            const content = character.repeat(100);
            const unpadded = { content, padding: '', omitted: undefined };
            const remaining = 131072 - new TextEncoder().encode(JSON.stringify(unpadded)).length;
            const allowed = { ...unpadded, padding: 'p'.repeat(remaining) };
            const oversized = { ...allowed, padding: `${allowed.padding}p` };

            expect(validateALMessageResourceLimits(allowed)).toEqual([]);
            expect(validateALMessageResourceLimits(oversized)[0]?.code).toBe('oversized');
            expect(validateSerializedALMessageSize(JSON.stringify(allowed))).toEqual([]);
            expect(validateSerializedALMessageSize(JSON.stringify(oversized))[0]?.code).toBe('oversized');
        }
    );

    it('applies specialized limits only to their exact envelope sections', () => {
        const value = {
            extension: {
                topicId: 't'.repeat(129),
                contextId: 'c'.repeat(129),
                resourceId: 'r'.repeat(129),
                ttlHops: 65,
                visitedPeerIds: Array.from({ length: 65 }, () => 'peer'),
                resource: 'not JSON'
            }
        };

        expect(validateALMessageResourceLimits(value)).toEqual([]);
    });

    it('limits protocol pages without imposing a room-size limit on domain payloads', () => {
        const members = Array.from({ length: 1000 }, (_, index) => `member-${index}`);
        const message = messageFixture();
        const snapshot = { ...message, payload: { ...message.payload, resource: JSON.stringify({ members }) } };

        expect(decodeALMessageValue(snapshot).right).toEqual(snapshot);
        expect(validateALMessageResourceLimits({ targets: { recipientPeerIds: members } })[0]?.code).toBe('oversized');
        for (let offset = 0; offset < members.length; offset += 256) {
            expect(validateALMessageResourceLimits({ targets: { recipientPeerIds: members.slice(offset, offset + 256) } })).toEqual([]);
        }
        expect(members).toHaveLength(1000);
    });

    it('returns malformed when an untrusted object cannot be inspected', () => {
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();

        expect(validateALMessageResourceLimits(revoked.proxy)[0]?.code).toBe('malformed');
    });

    it.each([
        { value: [undefined] },
        { value: { count: Infinity } },
        { value: { count: NaN } },
        { value: { count: 1n } },
        { value: { count: Symbol('count') } },
        { value: new Date(0) },
        { value: Object.create(null) },
        { value: Object.defineProperty({}, 'hidden', { value: 1 }) },
        { value: { [Symbol('hidden')]: 1 } }
    ])('rejects non-JSON values and hidden properties', ({ value }) => {
        expect(validateALMessageResourceLimits(value)[0]?.code).toBe('malformed');
    });

    it('does not mutate caller-owned values during acceptance or rejection', () => {
        const shared = Object.freeze({ value: 'safe' });
        const values = Object.freeze([shared, shared]);
        const allowed = Object.freeze({ values });
        const rejected = Object.freeze({ values, constraints: Object.freeze({ ttlHops: 65 }) });

        expect(validateALMessageResourceLimits(allowed)).toEqual([]);
        expect(validateALMessageResourceLimits(rejected)[0]?.code).toBe('oversized');
        expect(allowed).toEqual({ values: [{ value: 'safe' }, { value: 'safe' }] });
        expect(rejected).toEqual({ values: [{ value: 'safe' }, { value: 'safe' }], constraints: { ttlHops: 65 } });
    });
});

function messageFixture(): ALMessage {
    return {
        id: { v: 2, msgId: 'message-1', ts: 1, senderId: 'sender-1' },
        route: { topicId: 'app.message', contextId: 'context-1', resourceId: 'resource-1' },
        targets: { mode: 'unicast', toPeerId: 'receiver-1' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}
