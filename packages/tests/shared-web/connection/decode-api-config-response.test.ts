import { describe, expect, it } from 'vitest';

import { decodeApiConfigResponse } from '@shared-web/browser/connection/decode-api-config-response.ts';

const API_URL = new URL('https://api.example.test/api/config');

const SERVED = {
    apiBaseUrl: 'https://api.example.test',
    wsBaseUrl: 'wss://api.example.test',
    endpoints: { createWs: '/api/ws/:id' },
    serverPeerId: 'default-qbox-server'
};

describe('the /api/config boundary decoder', () => {
    it('reads the configuration and the WS server peer id', () => {
        expect(decodeApiConfigResponse({ ...SERVED, build: 'b-1' }, API_URL).right).toEqual(SERVED);
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
