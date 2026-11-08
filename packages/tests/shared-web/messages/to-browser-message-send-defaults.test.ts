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
        ['a granted room send under rtc', {}, 'rtc', false],
        ['a granted room send under rtc-with-ws-fallback', {}, 'rtc-with-ws-fallback', false],
        ['a granted room send under ws-then-rtc', {}, 'ws-then-rtc', true],
        ['a granted room send under ws', {}, 'ws', false]
    ])('answers for %s', (_name, send, strategy, expected) => {
        expect(isBrowserWsOnlySend({ send, channel: GRANTED, strategy })).toBe(expected);
    });

    it.each<RallarTypedMessageSendStrategy>(['rtc', 'rtc-with-ws-fallback', 'ws-then-rtc', 'ws'])(
        'an exclusive send under every strategy: %s',
        (strategy) => {
            expect(isBrowserWsOnlySend({ send: { ownership: 'exclusive' }, channel: GRANTED, strategy })).toBe(true);
        }
    );

    it.each<RallarTypedMessageSendStrategy>(['rtc', 'rtc-with-ws-fallback', 'ws-then-rtc', 'ws'])(
        'keeps a members channel\'s and a lane\'s shared send off WS-only under %s',
        (strategy) => {
            expect(isBrowserWsOnlySend({ send: {}, channel: MEMBERS, strategy })).toBe(false);
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
