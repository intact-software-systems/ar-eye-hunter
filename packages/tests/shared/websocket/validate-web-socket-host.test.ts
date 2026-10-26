import { describe, expect, it } from 'vitest';

import { validateWebSocketHost } from '@shared/websocket/validate-web-socket-host.ts';

describe('advertised WebSocket authority', () => {
    it.each([
        ['https://API.example.test:443/base', 'wss://api.example.test/socket'],
        ['http://api.example.test:80', 'ws://api.example.test'],
        ['http://[::1]:8080', 'ws://[::1]:8080/api/ws']
    ])('accepts the same normalized host for %s and %s', (api, webSocket) => {
        expect(validateWebSocketHost(new URL(api), new URL(webSocket))).toBeNull();
    });

    it.each([
        ['https://login.example.test', 'wss://elsewhere.example.test', 'login.example.test', 'elsewhere.example.test'],
        ['http://localhost:8080', 'ws://localhost:8090', 'localhost:8080', 'localhost:8090']
    ])('diagnoses a different authority for %s and %s', (api, webSocket, apiHost, webSocketHost) => {
        const issue = validateWebSocketHost(new URL(api), new URL(webSocket));

        expect(issue).toContain(apiHost);
        expect(issue).toContain(webSocketHost);
        expect(issue).toContain('RALLAR_WS_BASE_URL');
    });

    it('reports only hosts when URL objects also carry credentials and private parameters', () => {
        const issue = validateWebSocketHost(
            new URL('https://api-user:api-secret@login.example.test/private?api-key=hidden-api#api-fragment'),
            new URL('wss://ws-user:ws-secret@elsewhere.example.test/socket?ticket=hidden-ticket#ws-fragment')
        );

        expect(issue).toContain('login.example.test');
        expect(issue).toContain('elsewhere.example.test');
        expect(issue).not.toMatch(/api-user|api-secret|private|hidden-api|api-fragment|ws-user|ws-secret|hidden-ticket|ws-fragment/);
    });
});
