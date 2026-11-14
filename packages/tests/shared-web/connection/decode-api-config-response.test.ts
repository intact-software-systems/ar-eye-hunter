import { describe, expect, it } from 'vitest';

import { decodeApiConfigResponse } from '@shared-web/browser/connection/decode-api-config-response.ts';
import { MAX_RTC_REPLACED_LAYOUT_OVERLAP_MS } from '@shared/api/api-config.ts';
import { DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS } from '@shared/services/web-rtc-group-manager.ts';

const API_URL = new URL('https://api.example.test/api/config');

const SERVED = {
    apiBaseUrl: 'https://api.example.test',
    wsBaseUrl: 'wss://api.example.test',
    endpoints: { createWs: '/api/ws/:id' },
    serverPeerId: 'default-qbox-server',
    rtcReplacedLayoutOverlapMs: 7_000
};

const NO_OVERLAP = 'The /api/config response states no rtcReplacedLayoutOverlapMs that is an integer from 0 to 15000.';

describe('the /api/config boundary decoder', () => {
    it('reads the configuration and the WS server peer id', () => {
        expect(decodeApiConfigResponse({ ...SERVED, build: 'b-1' }, API_URL).right).toEqual(SERVED);
    });

    it('returns the replaced-layout overlap the server states', () => {
        expect(decodeApiConfigResponse(SERVED, API_URL).right?.rtcReplacedLayoutOverlapMs).toBe(7_000);
        expect(decodeApiConfigResponse({ ...SERVED, rtcReplacedLayoutOverlapMs: 0 }, API_URL).right?.rtcReplacedLayoutOverlapMs)
            .toBe(0);
        expect(
            decodeApiConfigResponse({ ...SERVED, rtcReplacedLayoutOverlapMs: MAX_RTC_REPLACED_LAYOUT_OVERLAP_MS }, API_URL).right
                ?.rtcReplacedLayoutOverlapMs
        ).toBe(MAX_RTC_REPLACED_LAYOUT_OVERLAP_MS);
    });

    it('refuses a response that states no replaced-layout overlap, as from a server that predates it', () => {
        const { rtcReplacedLayoutOverlapMs: _rtcReplacedLayoutOverlapMs, ...olderServer } = SERVED;

        expect(decodeApiConfigResponse(olderServer, API_URL).left).toBe(NO_OVERLAP);
    });

    it('refuses an overlap above the browser\'s connection grace', () => {
        const value = { ...SERVED, rtcReplacedLayoutOverlapMs: MAX_RTC_REPLACED_LAYOUT_OVERLAP_MS + 1 };

        expect(decodeApiConfigResponse(value, API_URL).left).toBe(NO_OVERLAP);
    });

    it('accepts at most the connection grace that keeps a replaced layout\'s edges open', () => {
        expect(MAX_RTC_REPLACED_LAYOUT_OVERLAP_MS).toBeLessThanOrEqual(DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS);
    });

    it.each([-1, 1.5, '7000', null])('refuses the overlap %j, which is not a whole number of milliseconds in range', (overlap) => {
        expect(decodeApiConfigResponse({ ...SERVED, rtcReplacedLayoutOverlapMs: overlap }, API_URL).left).toBe(NO_OVERLAP);
    });

    it('rejects a response missing the required WS server identity', () => {
        const { serverPeerId: _serverPeerId, ...unknownServer } = SERVED;

        expect(decodeApiConfigResponse(unknownServer, API_URL).left).toBe('The /api/config response names an empty or non-string WS server peer id.');
    });

    it.each([
        [
            'an empty peer id',
            { ...SERVED, serverPeerId: '' },
            'The /api/config response names an empty or non-string WS server peer id.'
        ],
        [
            'a non-string peer id',
            { ...SERVED, serverPeerId: 7 },
            'The /api/config response names an empty or non-string WS server peer id.'
        ],
        [
            'no WS endpoint',
            { ...SERVED, endpoints: {} },
            'The /api/config response names no API base URL, WS base URL or WS endpoint.'
        ],
        [
            'no endpoints object',
            { ...SERVED, endpoints: 'x' },
            'The /api/config response is not an object with endpoints.'
        ],
        ['a non-object body', 'config', 'The /api/config response is not an object with endpoints.']
    ])('refuses %s', (_name, value, reason) => {
        expect(decodeApiConfigResponse(value, API_URL).left).toBe(reason);
    });
    it('binds the WebSocket destination to the requested API, not the advertised API field', () => {
        const result = decodeApiConfigResponse({
            ...SERVED,
            apiBaseUrl: 'https://elsewhere.example.test',
            wsBaseUrl: 'wss://elsewhere.example.test'
        }, API_URL);

        expect(result.left).toBe(
            'WebSocket host "elsewhere.example.test" does not match API host "api.example.test". ' +
                'Check RALLAR_API_BASE_URL and RALLAR_WS_BASE_URL.'
        );
    });

    it.each(['wss://elsewhere.example.test/api/ws/:id', '//elsewhere.example.test/api/ws/:id'])(
        'rejects an endpoint that overrides the configured host: %s',
        (createWs) => {
            const result = decodeApiConfigResponse({ ...SERVED, endpoints: { createWs } }, API_URL);

            expect(result.left).toContain('WebSocket host "elsewhere.example.test"');
            expect(result.left).toContain('API host "api.example.test"');
        }
    );

    it('accepts an absolute endpoint on the same normalized authority', () => {
        const value = {
            ...SERVED,
            wsBaseUrl: 'wss://API.example.test:443/base',
            endpoints: { createWs: 'wss://api.example.test:443/api/ws/:id' }
        };

        expect(decodeApiConfigResponse(value, API_URL).right).toEqual(value);
    });

    it.each([
        { ...SERVED, wsBaseUrl: 'wss://[invalid?secret=hidden' },
        { ...SERVED, endpoints: { createWs: 'wss://[invalid?ticket=hidden' } },
        { ...SERVED, wsBaseUrl: 'https://api.example.test?secret=hidden' },
        { ...SERVED, endpoints: { createWs: 'https://api.example.test/api/ws/:id' } },
        { ...SERVED, wsBaseUrl: 'wss://user:hidden@api.example.test' },
        { ...SERVED, endpoints: { createWs: '/api/ws/:id#hidden' } }
    ])('rejects unusable WebSocket URLs without echoing their contents', (value) => {
        const result = decodeApiConfigResponse(value, API_URL);

        expect(result.left).toBe('The /api/config response names an invalid WS base URL or WS endpoint.');
    });
});
