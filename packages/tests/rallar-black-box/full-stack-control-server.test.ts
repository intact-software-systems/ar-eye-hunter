import { describe, expect, it } from 'vitest';
import {
    createFullStackControlWebServer,
    readFullStackControlBaseUrl,
    toFullStackControlWebSocketUrl
} from '../../../apps/rallar-black-box/playwright-full-stack-control-server.ts';

describe('rallar-black-box full-stack control server', () => {
    it('uses the established control base URL override for an isolated server', () => {
        expect(readFullStackControlBaseUrl({})).toBe('http://127.0.0.1:5180');
        expect(
            readFullStackControlBaseUrl({
                RALLAR_BLACK_BOX_CONTROL_BASE_URL: '  http://127.0.0.1:5280/  '
            })
        ).toBe('http://127.0.0.1:5280');

        const server = createFullStackControlWebServer({
            baseUrl: 'http://127.0.0.1:5280/',
            reuseExistingServer: false
        });

        expect(server.command).toContain('PORT=5280');
        expect(server.url).toBe('http://127.0.0.1:5280/health');
        expect(server.reuseExistingServer).toBe(false);
    });

    it('derives the matching control WebSocket URL', () => {
        expect(toFullStackControlWebSocketUrl('http://127.0.0.1:5280/')).toBe(
            'ws://127.0.0.1:5280/control'
        );
        expect(toFullStackControlWebSocketUrl('https://control.example.test')).toBe(
            'wss://control.example.test/control'
        );
    });
});
