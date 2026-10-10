import { describe, expect, it } from 'vitest';

import { parseRtcCaptureMode, resolveRtcCaptureConfiguration } from '@shared/webrtc/rtc-capture-configuration.ts';

describe('RTC capture selection', () => {
    it.each(['off', 'signaling', 'native'] as const)('accepts %s without coercion', (mode) => {
        expect(parseRtcCaptureMode(mode).right).toEqual({ mode });
    });
    it('represents omitted selection as a named successful value', () => {
        expect(parseRtcCaptureMode(undefined).right).toEqual({ mode: undefined });
    });
    it.each([null, true, false, '', 'inherit', 'OFF', 1, {}, []])('rejects invalid supplied selection %j', (value) => {
        const parsed = parseRtcCaptureMode(value);
        expect(parsed.right).toBeUndefined();
        expect(parsed.left).toEqual([{ code: 'invalid-rtc-capture-mode', message: expect.any(String) }]);
        expect(JSON.stringify(parsed.left)).not.toContain('value');
    });
    it.each(
        [
            { selections: { run: 'off', step: 'native', recipe: 'native', host: 'native' }, sinkAvailable: true, expected: { mode: 'off', origin: 'run' } },
            { selections: { step: 'off', recipe: 'native', host: 'native' }, sinkAvailable: true, expected: { mode: 'off', origin: 'step' } },
            { selections: { recipe: 'off', host: 'native' }, sinkAvailable: true, expected: { mode: 'off', origin: 'recipe' } },
            { selections: { host: 'off' }, sinkAvailable: true, expected: { mode: 'off', origin: 'host' } },
            { selections: {}, sinkAvailable: true, expected: { mode: 'signaling', origin: 'product-default' } },
            { selections: {}, sinkAvailable: false, expected: { mode: 'off', origin: 'product-default' } }
        ] as const
    )('selects literal precedence $expected.origin', ({ selections, sinkAvailable, expected }) => {
        expect(resolveRtcCaptureConfiguration({ ...selections, sinkAvailable })).toEqual(expected);
    });
});
