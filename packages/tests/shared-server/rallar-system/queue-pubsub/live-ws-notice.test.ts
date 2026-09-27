import { describe, expect, it } from 'vitest';

import { decodeLiveWsNotice, encodeLiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

const groupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const scope = { applicationId: 'app', workspaceId: 'workspace' };

function message(resource = ''): ALMessage {
    return {
        id: { v: 2, msgId: 'message-1', ts: 1, senderId: 'sender' },
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
        if (encoded.kind !== 'inline') {
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
        if (belowBoundary.kind === 'inline') {
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
