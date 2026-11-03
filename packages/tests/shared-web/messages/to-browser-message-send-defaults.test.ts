import type { RallarTypedMessageSendStrategy } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import {
    isBrowserWsOnlySend,
    type BrowserTypedChannelPolicy,
    type BrowserWsOnlySendInput
} from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { ALAckMode } from '@shared/al-contracts/al-contract.ts';
import { describe, expect, it } from 'vitest';

type RouteCase = readonly [string, BrowserWsOnlySendInput['send'], ALAckMode, RallarTypedMessageSendStrategy, boolean];

const GRANTED: BrowserTypedChannelPolicy = toChannel('granted');
const MEMBERS: BrowserTypedChannelPolicy = toChannel('members');

describe('isBrowserWsOnlySend', () => {
    it.each<RouteCase>([
        ['a granted room multicast without a receipt under rtc', {}, 'none', 'rtc', false],
        ['a granted room multicast without a receipt under rtc-with-ws-fallback', {}, 'none', 'rtc-with-ws-fallback', false],
        ['a granted room-scoped send without a receipt under rtc-with-ws-fallback', { scope: 'room' }, 'none', 'rtc-with-ws-fallback', false],
        ['a granted room multicast without a receipt under ws-then-rtc', {}, 'none', 'ws-then-rtc', true],
        ['a granted room multicast asking a receipt under rtc-with-ws-fallback', {}, 'receiver', 'rtc-with-ws-fallback', true],
        ['a granted room multicast asking a receipt under rtc', {}, 'all-logical-recipients', 'rtc', true],
        ['a granted peer send under rtc-with-ws-fallback', { peerId: 'b' }, 'none', 'rtc-with-ws-fallback', true],
        ['a granted world send under rtc-with-ws-fallback', { scope: 'world' }, 'none', 'rtc-with-ws-fallback', true],
        ['a granted principal send under rtc-with-ws-fallback', { scope: 'principal', principalId: 'p' }, 'none', 'rtc-with-ws-fallback', true],
        ['a granted send skipping sessions under rtc-with-ws-fallback', { exceptPeerIds: ['c'] }, 'none', 'rtc-with-ws-fallback', true],
        ['a granted listed send under rtc-with-ws-fallback', { recipientPeerIds: ['b'] }, 'none', 'rtc-with-ws-fallback', true],
        ['an exclusive room multicast without a receipt under rtc-with-ws-fallback', { ownership: 'exclusive' }, 'none', 'rtc-with-ws-fallback', true]
    ])('answers for %s', (_name, send, ack, strategy, expected) => {
        expect(isBrowserWsOnlySend({ send, channel: GRANTED, ack, strategy })).toBe(expected);
    });

    it.each<RallarTypedMessageSendStrategy>(['rtc', 'rtc-with-ws-fallback', 'ws-then-rtc'])(
        'keeps a members channel\'s shared send off WS-only under %s, whatever its audience or receipt',
        (strategy) => {
            expect(isBrowserWsOnlySend({ send: { peerId: 'b' }, channel: MEMBERS, ack: 'receiver', strategy })).toBe(false);
            expect(isBrowserWsOnlySend({ send: {}, channel: undefined, ack: 'receiver', strategy })).toBe(false);
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
