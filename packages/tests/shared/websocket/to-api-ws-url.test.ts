import { describe, expect, it } from 'vitest';

import { API_CREATE_WS_PATH, toApiWsUrl } from '@shared/websocket/to-api-ws-url.ts';

const WS_BASE_URL = 'wss://api.example.test';
const SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

describe('toApiWsUrl', () => {
    it('builds the upgrade URL from the configured path with the ticket and scope', () => {
        const url = toApiWsUrl({
            wsBaseUrl: WS_BASE_URL,
            createWsPath: '/api/ws/:id',
            sessionId: 'session-1',
            ticket: 'ticket-1',
            scope: SCOPE
        });

        expect(url).toBe(
            'wss://api.example.test/api/ws/session-1?ticket=ticket-1&applicationId=ar-eye-hunter&workspaceId=default'
        );
    });

    it('encodes the session id into the path', () => {
        const url = new URL(toApiWsUrl({
            wsBaseUrl: WS_BASE_URL,
            createWsPath: API_CREATE_WS_PATH,
            sessionId: 'session/one',
            ticket: 'ticket-1',
            scope: undefined
        }));

        expect(url.pathname).toBe('/api/ws/session%2Fone');
    });

    it('leaves every id the API mints unchanged by encoding', () => {
        const mintedSessionId = 'session-AZaz09_-AZaz09_-AZaz09_-';
        const mintedTicket = 'AZaz09_-AZaz09_-AZaz09_-AZaz09_-AZaz09_-AZaz09_-.AZaz09_-';
        const url = new URL(toApiWsUrl({
            wsBaseUrl: WS_BASE_URL,
            createWsPath: API_CREATE_WS_PATH,
            sessionId: mintedSessionId,
            ticket: mintedTicket,
            scope: SCOPE
        }));

        expect(url.pathname).toBe(`/api/ws/${mintedSessionId}`);
        expect(url.searchParams.get('ticket')).toBe(mintedTicket);
        expect(url.search.startsWith(`?ticket=${mintedTicket}&`)).toBe(true);
    });

    it('names no scope parameters for a connect without one', () => {
        const url = new URL(toApiWsUrl({
            wsBaseUrl: WS_BASE_URL,
            createWsPath: API_CREATE_WS_PATH,
            sessionId: 'session-1',
            ticket: 'ticket-1',
            scope: undefined
        }));

        expect([...url.searchParams.keys()]).toEqual(['ticket']);
    });

    it('keeps ticket, applicationId, workspaceId in that order', () => {
        const url = new URL(toApiWsUrl({
            wsBaseUrl: WS_BASE_URL,
            createWsPath: API_CREATE_WS_PATH,
            sessionId: 'session-1',
            ticket: 'ticket-1',
            scope: SCOPE
        }));

        expect([...url.searchParams.keys()]).toEqual(['ticket', 'applicationId', 'workspaceId']);
    });

    it('serves the path the API configuration serves', () => {
        expect(API_CREATE_WS_PATH).toBe('/api/ws/:id');
    });
});
