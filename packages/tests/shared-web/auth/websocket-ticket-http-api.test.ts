// @vitest-environment happy-dom
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import type { ApiMutationRequestOptions } from '@shared-web/browser/api/http-request.ts';
import {
    configureWebSocketTicketCircuitBreaker,
    configureWebSocketTicketLocalRateLimit,
    createWebSocketTicket as requestWebSocketTicket,
    readWebSocketTicketBackoffState,
    resetWebSocketTicketBackoff
} from '@shared-web/browser/auth/websocket-ticket-http-api.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createWebSocketTicket(
    options: Omit<ApiMutationRequestOptions, 'requestId'>
) {
    return requestWebSocketTicket({
        requestId: 'websocket-ticket-request-id',
        ...options
    });
}

const SERVER_UNAVAILABLE_ERROR = new RegExp(
    'API POST /api/auth/ws-ticket/requests/[A-Za-z0-9_-]+ ' +
        'failed: 503 server unavailable'
);

describe('WebSocket ticket HTTP backoff', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        configureApiClient({ apiBaseUrl: 'https://api.test' });
        resetWebSocketTicketBackoff();
        configureWebSocketTicketCircuitBreaker({
            maxConsecutiveFailures: 10,
            resetTimeoutMs: 10_000,
            halfOpenTimeoutMs: 10_000,
            slidingWindowMs: 10_000
        });
        configureWebSocketTicketLocalRateLimit({ windowMs: 60_000, maxRequests: 30 });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        configureApiClient({ apiBaseUrl: '' });
        resetWebSocketTicketBackoff();
        configureWebSocketTicketCircuitBreaker({
            maxConsecutiveFailures: 10,
            resetTimeoutMs: 10_000,
            halfOpenTimeoutMs: 10_000,
            slidingWindowMs: 10_000
        });
        configureWebSocketTicketLocalRateLimit({ windowMs: 60_000, maxRequests: 30 });
    });

    it('suppresses repeated ws ticket requests after a 429 response', async () => {
        const fetchMock = vi.fn(async () =>
            new Response('too many', {
                status: 429,
                headers: { 'retry-after': '4' }
            })
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(createWebSocketTicket({ authSession: null })).rejects.toThrow(
            /API POST \/api\/auth\/ws-ticket\/requests\/[A-Za-z0-9_-]+ failed: 429 too many/
        );

        expect(readWebSocketTicketBackoffState()).toMatchObject({
            status: 'cooldown',
            retryAtEpochMs: 5_000,
            lastStatus: 429
        });

        await expect(createWebSocketTicket({ authSession: null })).rejects.toThrow(
            'WebSocket ticket request suppressed until cooldown expires.'
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(4_001);
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    ticket: 'ticket-1',
                    sessionId: 'session-1',
                    expiresAtEpochMs: 10_000
                }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                }
            )
        );

        await expect(createWebSocketTicket({ authSession: null })).resolves.toMatchObject({
            ticket: 'ticket-1',
            sessionId: 'session-1'
        });
        expect(readWebSocketTicketBackoffState()).toMatchObject({
            status: 'idle'
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reuses a caller-owned request ID when a ws ticket response is lost', async () => {
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new TypeError('response lost'))
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        ticket: 'ticket-1',
                        sessionId: 'session-1',
                        expiresAtEpochMs: 10_000
                    }),
                    {
                        status: 200,
                        headers: { 'content-type': 'application/json' }
                    }
                )
            );
        vi.stubGlobal('fetch', fetchMock);
        const options = {
            requestId: 'websocket-lost-response-id',
            authSession: null
        } as const;

        await expect(requestWebSocketTicket(options)).rejects.toThrow('response lost');
        await expect(requestWebSocketTicket(options)).resolves.toMatchObject({
            ticket: 'ticket-1'
        });

        expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
            'https://api.test/api/auth/ws-ticket/requests/websocket-lost-response-id',
            'https://api.test/api/auth/ws-ticket/requests/websocket-lost-response-id'
        ]);
    });

    it('locally suppresses ticket storms before hitting the API', async () => {
        configureWebSocketTicketLocalRateLimit({ windowMs: 60_000, maxRequests: 1 });
        const fetchMock = vi.fn(async () =>
            new Response(
                JSON.stringify({
                    ticket: 'ticket-1',
                    sessionId: 'session-1',
                    expiresAtEpochMs: 10_000
                }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                }
            )
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(createWebSocketTicket({
            authSession: {
                clientId: 'client-1',
                sessionId: 'session-1',
                username: 'test',
                accessToken: 'token-1',
                expiresAtEpochMs: 61_000
            }
        })).resolves.toMatchObject({
            ticket: 'ticket-1',
            sessionId: 'session-1'
        });

        await expect(createWebSocketTicket({
            authSession: {
                clientId: 'client-1',
                sessionId: 'session-1',
                username: 'test',
                accessToken: 'token-1',
                expiresAtEpochMs: 61_000
            }
        })).rejects.toThrow(
            'WebSocket ticket request suppressed by local client rate limiter.'
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(readWebSocketTicketBackoffState()).toMatchObject({
            status: 'local-rate-limited',
            lastStatus: 429
        });
    });

    it('opens a local circuit after server failures and suppresses the next ticket request', async () => {
        configureWebSocketTicketCircuitBreaker({
            maxConsecutiveFailures: 0,
            resetTimeoutMs: 60_000,
            halfOpenTimeoutMs: 10_000,
            slidingWindowMs: 60_000
        });
        const fetchMock = vi.fn(async () => new Response('server unavailable', { status: 503 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(createWebSocketTicket({ authSession: null })).rejects.toThrow(
            SERVER_UNAVAILABLE_ERROR
        );

        await expect(createWebSocketTicket({ authSession: null })).rejects.toThrow(
            'WebSocket ticket request suppressed by local circuit breaker.'
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(readWebSocketTicketBackoffState()).toMatchObject({
            status: 'circuit-open',
            lastStatus: 503
        });
    });

    it('does not trip the circuit breaker for server 429 cooldown responses', async () => {
        configureWebSocketTicketCircuitBreaker({
            maxConsecutiveFailures: 0,
            resetTimeoutMs: 60_000,
            halfOpenTimeoutMs: 10_000,
            slidingWindowMs: 60_000
        });
        const fetchMock = vi.fn(async () =>
            new Response('too many', {
                status: 429,
                headers: { 'retry-after': '1' }
            })
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(createWebSocketTicket({ authSession: null })).rejects.toThrow(
            /API POST \/api\/auth\/ws-ticket\/requests\/[A-Za-z0-9_-]+ failed: 429 too many/
        );

        await vi.advanceTimersByTimeAsync(1_001);
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    ticket: 'ticket-2',
                    sessionId: 'session-2',
                    expiresAtEpochMs: 10_000
                }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                }
            )
        );

        await expect(createWebSocketTicket({ authSession: null })).resolves.toMatchObject({
            ticket: 'ticket-2',
            sessionId: 'session-2'
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(readWebSocketTicketBackoffState()).toMatchObject({
            status: 'idle'
        });
    });

    it('keeps circuit-open diagnostics ahead of the local rate limiter while open', async () => {
        configureWebSocketTicketLocalRateLimit({ windowMs: 60_000, maxRequests: 1 });
        configureWebSocketTicketCircuitBreaker({
            maxConsecutiveFailures: 0,
            resetTimeoutMs: 60_000,
            halfOpenTimeoutMs: 10_000,
            slidingWindowMs: 60_000
        });
        const fetchMock = vi.fn(async () => new Response('server unavailable', { status: 503 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(createWebSocketTicket({ authSession: null })).rejects.toThrow(
            SERVER_UNAVAILABLE_ERROR
        );

        await expect(createWebSocketTicket({ authSession: null })).rejects.toThrow(
            'WebSocket ticket request suppressed by local circuit breaker.'
        );
        await expect(createWebSocketTicket({ authSession: null })).rejects.toThrow(
            'WebSocket ticket request suppressed by local circuit breaker.'
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(readWebSocketTicketBackoffState()).toMatchObject({
            status: 'circuit-open',
            lastStatus: 503
        });
    });
});
