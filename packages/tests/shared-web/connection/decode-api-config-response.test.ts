import { describe, expect, it } from 'vitest';

import { decodeApiConfigResponse } from '@shared-web/browser/connection/decode-api-config-response.ts';

const SERVED = {
    apiBaseUrl: 'https://api.example.test',
    wsBaseUrl: 'wss://api.example.test',
    endpoints: { createWs: '/api/ws/:id' },
    serverPeerId: 'default-qbox-server'
};

describe('the /api/config boundary decoder', () => {
    it('reads the configuration and the WS server peer id', () => {
        expect(decodeApiConfigResponse({ ...SERVED, build: 'b-1' }).right).toEqual(SERVED);
    });

    it('rejects a response missing the required WS server identity', () => {
        const { serverPeerId: _serverPeerId, ...unknownServer } = SERVED;

        expect(decodeApiConfigResponse(unknownServer).left).toBe('The /api/config response names an empty or non-string WS server peer id.');
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
        expect(decodeApiConfigResponse(value).left).toBe(reason);
    });
});
