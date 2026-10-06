import { describe, expect, it } from 'vitest';

import { decodeLiveWsNotice, encodeLiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';

const groupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const scope = { applicationId: 'app', workspaceId: 'workspace' };

function message(resource = ''): ALMessage {
    return {
        id: { v: 3, msgId: 'message-1', ts: 1, senderId: 'sender' },
        route: { topicId: 'room.match', resourceId: 'room', contextId: 'room' },
        targets: { mode: 'multicast', groupRef },
        constraints: { expiresAtMs: 1_800_000_000_000 },
        payload: { typeId: 'room.match', resource: JSON.stringify(resource) }
    };
}

function publication(resource = '') {
    return {
        channel: 'ws-channel',
        publisherId: 'publisher-a',
        scope,
        expiresAtMs: 1_800_000_000_000,
        audience: { mode: 'room' as const, groupRef, recipientSessionIds: ['session-1'] },
        message: message(resource)
    };
}

describe('live WS notice codec', () => {
    it('round trips broad inline and canonical key notices without an invented scope', () => {
        const broadMessage: ALMessage = {
            ...message(),
            targets: { mode: 'broadcast', scope: 'world' }
        };
        const broad = {
            channel: 'ws-channel',
            publisherId: 'publisher-a',
            expiresAtMs: 1_800_000_000_000,
            audience: { mode: 'broad' as const, targetMode: 'world' as const },
            message: broadMessage
        };
        const inline = encodeLiveWsNotice(broad);
        expect(inline.kind).toBe('inline');
        if (inline.kind === 'inline') {
            expect(Object.hasOwn(inline.notice, 'scope')).toBe(false);
            expect(decodeLiveWsNotice(JSON.parse(inline.serialized), 'ws-channel', 1)).toEqual(inline.notice);
        }
        const key = encodeLiveWsNotice({
            ...broad,
            message: { ...broadMessage, payload: { ...broadMessage.payload, resource: JSON.stringify('x'.repeat(8_000)) } },
            inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'message-1' } }
        });
        expect(key.kind).toBe('inbound-key');
        if (key.kind === 'inbound-key') {
            expect(Object.hasOwn(key.notice, 'scope')).toBe(false);
            expect(key.notice).toMatchObject({ audienceMode: 'broad', targetMode: 'world' });
            expect(decodeLiveWsNotice(JSON.parse(key.serialized), 'ws-channel', 1)).toEqual(key.notice);
            if (key.notice.delivery === 'inbound-key' && key.notice.audienceMode === 'broad') {
                const { targetMode: _targetMode, ...missingTargetMode } = key.notice;
                expect(decodeLiveWsNotice(missingTargetMode, 'ws-channel', 1)).toBeUndefined();
            }
        }
    });

    it('rejects broad scope spoofing and scoped notices missing scope', () => {
        const broadMessage: ALMessage = { ...message(), targets: { mode: 'broadcast', scope: 'all' } };
        const broad = {
            channel: 'ws-channel',
            publisherId: 'publisher-a',
            expiresAtMs: 1_800_000_000_000,
            audience: { mode: 'broad' as const, targetMode: 'all' as const },
            message: broadMessage
        };
        const spoofed = { ...broad };
        Reflect.set(spoofed, 'scope', scope);
        expect(() => encodeLiveWsNotice(spoofed)).toThrow(TypeError);
        const broadInline = {
            kind: 'live-ws',
            version: 1,
            ...broad,
            delivery: 'inline'
        };
        expect(decodeLiveWsNotice({ ...broadInline, scope }, 'ws-channel', 1)).toBeUndefined();
        const broadKey = {
            kind: 'live-ws',
            version: 1,
            channel: 'ws-channel',
            publisherId: 'publisher-a',
            expiresAtMs: 1_800_000_000_000,
            delivery: 'inbound-key',
            audienceMode: 'broad',
            targetMode: 'all',
            inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'message-1' } }
        };
        expect(decodeLiveWsNotice({ ...broadKey, scope }, 'ws-channel', 1)).toBeUndefined();
        const missingScope = { ...publication() };
        Reflect.deleteProperty(missingScope, 'scope');
        expect(() => encodeLiveWsNotice(missingScope)).toThrow(TypeError);
        const scoped = encodeLiveWsNotice(publication());
        if (scoped.kind !== 'inline') {
            throw new Error('Expected scoped inline fixture');
        }
        const { scope: _scope, ...withoutScope } = scoped.notice;
        expect(decodeLiveWsNotice(withoutScope, 'ws-channel', 1)).toBeUndefined();
        expect(decodeLiveWsNotice({ ...broadKey, audienceMode: 'room' }, 'ws-channel', 1)).toBeUndefined();
    });

    it('rejects mismatched broad target modes', () => {
        const broad = {
            channel: 'ws-channel',
            publisherId: 'publisher-a',
            expiresAtMs: 1_800_000_000_000,
            audience: { mode: 'broad' as const, targetMode: 'all' as const },
            message: { ...message(), targets: { mode: 'broadcast' as const, scope: 'world' as const } }
        };
        expect(() => encodeLiveWsNotice(broad)).toThrow(TypeError);
        expect(decodeLiveWsNotice({ kind: 'live-ws', version: 1, delivery: 'inline', ...broad }, 'ws-channel', 1)).toBeUndefined();
    });

    it.each(['peer', 'principal'] as const)('refuses oversized canonical %s notices', (mode) => {
        const principalRef = { ...scope, principalId: 'principal-1' };
        const audience = mode === 'peer'
            ? { mode, recipientSessionIds: ['session-1'] }
            : { mode, principalRef, recipientSessionIds: ['session-1'] };
        const targets = mode === 'peer'
            ? { mode: 'unicast' as const, toPeerId: 'session-1' }
            : { mode: 'broadcast' as const, scope: 'principal' as const, principalRef };
        const encoded = encodeLiveWsNotice({
            ...publication('x'.repeat(8_000)),
            audience,
            message: { ...message('x'.repeat(8_000)), targets },
            inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'message-1' } }
        });
        expect(encoded).toMatchObject({ kind: 'oversize', keyBytes: undefined });
    });

    it('uses a canonical key at the exact RTC peer notice boundary', () => {
        const rtcMessage: ALMessage = {
            ...message('x'.repeat(8_000)),
            route: { ...message().route, topicId: 'rtc-signaling' },
            payload: { ...message('x'.repeat(8_000)).payload, typeId: 'rtc-signaling' },
            targets: { mode: 'unicast', toPeerId: 'session-1' }
        };
        const input = {
            ...publication(),
            message: rtcMessage,
            audience: { mode: 'peer' as const, recipientSessionIds: ['session-1'] },
            inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'message-1' } }
        };
        const encoded = encodeLiveWsNotice(input);
        expect(encoded.kind).toBe('inbound-key');
        if (encoded.kind === 'inbound-key') {
            expect(encoded.notice).toMatchObject({ audienceMode: 'peer', scope });
            expect(new TextEncoder().encode(encoded.serialized).length).toBeLessThan(8_000);
        }
        const empty = encodeLiveWsNotice({
            ...input,
            message: { ...rtcMessage, payload: { ...rtcMessage.payload, resource: JSON.stringify('') } }
        });
        expect(empty.kind).toBe('inline');
        if (empty.kind !== 'inline') {
            return;
        }
        const baselineBytes = new TextEncoder().encode(empty.serialized).length;
        const withResource = (length: number) =>
            encodeLiveWsNotice({
                ...input,
                message: { ...rtcMessage, payload: { ...rtcMessage.payload, resource: JSON.stringify('x'.repeat(length)) } }
            });
        expect(withResource(7_999 - baselineBytes)).toMatchObject({ kind: 'inline' });
        expect(withResource(8_000 - baselineBytes)).toMatchObject({ kind: 'inbound-key' });
    });

    it('accepts an explicit logical deadline for a message without AL expiry', () => {
        const { id, route, payload } = message();
        const { scope: _scope, ...broadPublication } = publication();
        const encoded = encodeLiveWsNotice({
            ...broadPublication,
            audience: { mode: 'broad', targetMode: 'all' },
            message: { id, route, payload, targets: { mode: 'broadcast', scope: 'all' } }
        });
        expect(encoded.kind).toBe('inline');
        if (encoded.kind === 'inline') {
            expect(decodeLiveWsNotice(JSON.parse(encoded.serialized), 'ws-channel', 1)).toEqual(encoded.notice);
        }
    });

    it('does not let a notice extend an existing AL expiry', () => {
        const extended = { ...publication(), expiresAtMs: 1_800_000_000_001 };
        expect(() => encodeLiveWsNotice(extended)).toThrow(TypeError);
        const encoded = encodeLiveWsNotice(publication());
        expect(encoded.kind).toBe('inline');
    });

    it('does not extend a fresh-until QoS expiry carried by the message', () => {
        const { id, route, payload } = message();
        const qosMessage: ALMessage = {
            id,
            route,
            payload,
            targets: { mode: 'broadcast', scope: 'all' },
            qos: { expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 10 } } }
        };
        const { scope: _scope, ...broadPublication } = publication();
        const input = {
            ...broadPublication,
            audience: { mode: 'broad' as const, targetMode: 'all' as const },
            message: qosMessage
        };
        expect(() => encodeLiveWsNotice({ ...input, expiresAtMs: 12 })).toThrow(TypeError);
        expect(encodeLiveWsNotice({ ...input, expiresAtMs: 11 }).kind).toBe('inline');
    });

    it('encodes a standard broadcast builder as the exact JSON-clean notice sent by transport', () => {
        const built = newALBroadcastMessage('server', newALRoute('room.match', 'world', 'resource'), 'all', 'room.match', { text: 'hello' });
        const { scope: _scope, ...broadPublication } = publication();
        const encoded = encodeLiveWsNotice({
            ...broadPublication,
            audience: { mode: 'broad', targetMode: 'all' },
            message: built
        });
        expect(encoded.kind).toBe('inline');
        if (encoded.kind === 'inline') {
            expect(encoded.notice).toEqual(JSON.parse(encoded.serialized));
            expect(decodeLiveWsNotice(JSON.parse(encoded.serialized), 'ws-channel', 1)).toEqual(encoded.notice);
        }
    });

    it('does not clean a missing mandatory AL field into a valid notice', () => {
        const malformed = structuredClone(message());
        Reflect.set(malformed.payload, 'resource', undefined);
        expect(() => encodeLiveWsNotice({ ...publication(), message: malformed })).toThrow(TypeError);
    });

    it('does not silently erase an undefined audience field', () => {
        const audience = { mode: 'room' as const, groupRef, recipientSessionIds: ['session-1'] };
        Reflect.set(audience, 'unexpected', undefined);
        expect(() => encodeLiveWsNotice({ ...publication(), audience })).toThrow(TypeError);
    });

    it('round trips a final inline message and its frozen room audience', () => {
        const encoded = encodeLiveWsNotice(publication());
        expect(encoded.kind).toBe('inline');
        if (encoded.kind !== 'inline') {
            return;
        }
        expect(decodeLiveWsNotice(JSON.parse(encoded.serialized), 'ws-channel', 1_799_999_999_999))
            .toEqual(encoded.notice);
    });

    it('rejects a spoofed room scope, malformed audience, and expired notice', () => {
        const encoded = encodeLiveWsNotice(publication());
        expect(encoded.kind).toBe('inline');
        if (encoded.kind !== 'inline' || encoded.notice.delivery !== 'inline') {
            return;
        }
        expect(decodeLiveWsNotice({ ...encoded.notice, scope: { applicationId: 'other', workspaceId: 'workspace' } }, 'ws-channel', 1)).toBeUndefined();
        expect(decodeLiveWsNotice({ ...encoded.notice, audience: { ...encoded.notice.audience, recipientSessionIds: [''] } }, 'ws-channel', 1)).toBeUndefined();
        expect(decodeLiveWsNotice(encoded.notice, 'ws-channel', 1_800_000_000_000)).toBeUndefined();
        expect(decodeLiveWsNotice(encoded.notice, 'other-channel', 1)).toBeUndefined();
    });

    it('uses serialized UTF-8 bytes and keeps the notice strictly below 8000 bytes', () => {
        const baseline = encodeLiveWsNotice(publication());
        expect(baseline.kind).toBe('inline');
        if (baseline.kind !== 'inline') {
            return;
        }
        const baselineBytes = new TextEncoder().encode(baseline.serialized).length;
        const atBoundary = encodeLiveWsNotice(publication('x'.repeat(8_000 - baselineBytes)));
        expect(atBoundary).toMatchObject({ kind: 'oversize', inlineBytes: 8_000 });
        const belowBoundary = encodeLiveWsNotice(publication('x'.repeat(7_999 - baselineBytes)));
        expect(belowBoundary.kind).toBe('inline');
        if (belowBoundary.kind === 'inline' && belowBoundary.notice.delivery === 'inline') {
            expect(new TextEncoder().encode(belowBoundary.serialized).length).toBe(7_999);
            expect(decodeLiveWsNotice(JSON.parse(belowBoundary.serialized), 'ws-channel', 1)).toEqual(belowBoundary.notice);
            const atDecodeBoundary = {
                ...belowBoundary.notice,
                message: {
                    ...belowBoundary.notice.message,
                    payload: {
                        ...belowBoundary.notice.message.payload,
                        resource: `${belowBoundary.notice.message.payload.resource.slice(0, -1)}x"`
                    }
                }
            };
            expect(new TextEncoder().encode(JSON.stringify(atDecodeBoundary)).length).toBe(8_000);
            expect(decodeLiveWsNotice(atDecodeBoundary, 'ws-channel', 1)).toBeUndefined();
        }
        expect(encodeLiveWsNotice(publication('é'.repeat(4_000)))).toMatchObject({ kind: 'oversize' });
    });

    it('uses the canonical inbound key for an oversized message', () => {
        const encoded = encodeLiveWsNotice({
            ...publication('x'.repeat(8_000)),
            inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'message-1' } }
        });
        expect(encoded.kind).toBe('inbound-key');
        if (encoded.kind !== 'inbound-key') {
            return;
        }
        expect(new TextEncoder().encode(encoded.serialized).length).toBeLessThan(8_000);
        expect(decodeLiveWsNotice(JSON.parse(encoded.serialized), 'ws-channel', 1)).toEqual(encoded.notice);
    });

    it('keeps a large frozen audience behind the canonical inbound reference', () => {
        const encoded = encodeLiveWsNotice({
            ...publication('x'.repeat(8_000)),
            audience: { mode: 'room', groupRef, recipientSessionIds: Array.from({ length: 1000 }, (_, index) => `session-${index}`) },
            inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'message-1' } }
        });
        expect(encoded.kind).toBe('inbound-key');
        if (encoded.kind === 'inbound-key') {
            expect(encoded.serialized).not.toContain('session-999');
            expect(encoded.notice).toMatchObject({ audienceMode: 'room' });
        }
    });

    it('refuses oversized noncanonical publications instead of claiming success', () => {
        expect(encodeLiveWsNotice(publication('x'.repeat(8_000)))).toMatchObject({ kind: 'oversize' });
    });

    it('refuses a canonical reference whose key notice exceeds the wire budget', () => {
        expect(encodeLiveWsNotice({
            ...publication('x'.repeat(8_000)),
            inbound: { namespace: 'n'.repeat(8_000), reference: { senderId: 'sender', msgId: 'message-1' } }
        })).toMatchObject({ kind: 'oversize' });
    });

    it('binds principal broadcasts to a full scoped principal and frozen audience', () => {
        const principalRef = { ...scope, principalId: 'principal-1' };
        const input = {
            ...publication(),
            audience: { mode: 'principal' as const, principalRef, recipientSessionIds: ['session-1'] },
            message: {
                ...message(),
                targets: { mode: 'broadcast' as const, scope: 'principal' as const, principalRef }
            }
        };
        const encoded = encodeLiveWsNotice(input);
        expect(encoded.kind).toBe('inline');
        if (encoded.kind !== 'inline') {
            return;
        }
        expect(decodeLiveWsNotice(encoded.notice, 'ws-channel', 1)).toEqual(encoded.notice);
        expect(decodeLiveWsNotice(
            {
                ...encoded.notice,
                audience: { mode: 'principal', principalRef: { ...principalRef, applicationId: 'other' }, recipientSessionIds: ['session-1'] }
            },
            'ws-channel',
            1
        )).toBeUndefined();
    });
});
