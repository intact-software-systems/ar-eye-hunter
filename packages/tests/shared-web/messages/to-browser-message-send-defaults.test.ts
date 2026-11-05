import type { RallarTypedMessageSendStrategy } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import {
    isBrowserWsOnlySend,
    isRallarRoomNarrowedAudience,
    type BrowserTypedChannelPolicy,
    type BrowserWsOnlySendInput
} from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import { describe, expect, it } from 'vitest';

type RouteCase = readonly [string, BrowserWsOnlySendInput['send'], RallarTypedMessageSendStrategy, boolean];

const GRANTED: BrowserTypedChannelPolicy = toChannel('granted');
const MEMBERS: BrowserTypedChannelPolicy = toChannel('members');

describe('isBrowserWsOnlySend', () => {
    it.each<RouteCase>([
        ['a granted room multicast under rtc', {}, 'rtc', false],
        ['a granted room multicast under rtc-with-ws-fallback', {}, 'rtc-with-ws-fallback', false],
        ['a granted room-scoped send under rtc-with-ws-fallback', { scope: 'room' }, 'rtc-with-ws-fallback', false],
        ['a granted room multicast under ws-then-rtc', {}, 'ws-then-rtc', true],
        ['a granted peer send under rtc-with-ws-fallback', { peerId: 'b' }, 'rtc-with-ws-fallback', true],
        ['a granted world send under rtc-with-ws-fallback', { scope: 'world' }, 'rtc-with-ws-fallback', true],
        ['a granted principal send under rtc-with-ws-fallback', { scope: 'principal', principalId: 'p' }, 'rtc-with-ws-fallback', true],
        ['a granted send skipping sessions under rtc-with-ws-fallback', { exceptPeerIds: ['c'] }, 'rtc-with-ws-fallback', true],
        ['a granted listed send under rtc-with-ws-fallback', { recipientPeerIds: ['b'] }, 'rtc-with-ws-fallback', true],
        ['an exclusive room multicast under rtc-with-ws-fallback', { ownership: 'exclusive' }, 'rtc-with-ws-fallback', true]
    ])('answers for %s', (_name, send, strategy, expected) => {
        expect(isBrowserWsOnlySend({ send, channel: GRANTED, strategy })).toBe(expected);
    });

    it.each<RallarTypedMessageSendStrategy>(['rtc', 'rtc-with-ws-fallback', 'ws-then-rtc'])(
        'keeps a members channel\'s shared send off WS-only under %s, whatever its audience',
        (strategy) => {
            expect(isBrowserWsOnlySend({ send: { peerId: 'b' }, channel: MEMBERS, strategy })).toBe(false);
            expect(isBrowserWsOnlySend({ send: {}, channel: undefined, strategy })).toBe(false);
        }
    );
});

function toChannel(access: BrowserTypedChannelPolicy['access']): BrowserTypedChannelPolicy {
    return {
        purpose: 'notification',
        access,
        durability: undefined,
        onStorageUnavailable: 'refuse',
        publication: undefined
    };
}

describe('isRallarRoomNarrowedAudience', () => {
    it.each([
        { audience: {}, expected: false },
        { audience: { exceptPeerIds: [] }, expected: true },
        { audience: { principalId: 'p' }, expected: true },
        { audience: { recipientPeerIds: ['b'] }, expected: true }
    ])('answers $expected for $audience: a narrowed room send is a broadcast on either carrier', ({ audience, expected }) => {
        expect(isRallarRoomNarrowedAudience(audience)).toBe(expected);
    });
});
