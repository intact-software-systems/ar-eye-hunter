import { describe, expect, it } from 'vitest';

import { decodeAlmFaultRewrite } from '@shared-test/rallar-bb-test/alm/decode-alm-fault-rewrite.ts';

describe('decodeAlmFaultRewrite', () => {
    it.each([
        ['an action naming no rewrite', { carrier: 'rtc', action: 'drop' }],
        ['a delay action', { carrier: 'ws', action: { delayMs: 10 } }],
        ['a fault that is not an object', 'drop']
    ])('answers Right null for %s, which the caller judges as any other fault', (_name, fault) => {
        expect(decodeAlmFaultRewrite(fault).right).toBeNull();
    });

    it('answers the rewrite it names on the rtc carrier', () => {
        expect(decodeAlmFaultRewrite({ carrier: 'rtc', action: { rewrite: 'strip-proof' } }).right).toBe('strip-proof');
        expect(decodeAlmFaultRewrite({ carrier: 'rtc', action: { rewrite: { forgeSender: { principal: 'p' } } } }).right)
            .toEqual({ forgeSender: { principal: 'p' } });
    });

    it('refuses a rewrite off the rtc carrier and a rewrite of any other shape', () => {
        expect(decodeAlmFaultRewrite({ carrier: 'ws', action: { rewrite: 'strip-proof' } }).left)
            .toBe('fault.inject.action.rewrite is offered on the rtc carrier only.');
        expect(decodeAlmFaultRewrite({ carrier: 'rtc', action: { rewrite: { forgeSender: {} } } }).left)
            .toMatch(/^fault\.inject\.action\.rewrite must be/);
    });
});
