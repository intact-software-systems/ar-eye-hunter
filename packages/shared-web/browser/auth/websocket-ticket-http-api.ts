import { Temporal } from '@js-temporal/polyfill';
import type { WebSocketTicketResponse } from '@shared/api/api-config.ts';
import { readSession } from '@shared/api/auth.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { CircuitBreaker, CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { ApiHttpError } from '../api/http-error.ts';
import { executeHttpRequest, type ApiMutationRequestOptions } from '../api/http-request.ts';

export type WebSocketTicketBackoffState = Readonly<
    | {
        status: 'idle';
        lastStatus?: number;
        lastFailureAtEpochMs?: number;
    }
    | {
        status: 'cooldown';
        retryAtEpochMs: number;
        lastStatus: number;
        lastFailureAtEpochMs: number;
        reason: string;
    }
    | {
        status: 'local-rate-limited';
        lastStatus: number;
        lastFailureAtEpochMs: number;
        reason: string;
    }
    | {
        status: 'circuit-open';
        lastStatus: number;
        lastFailureAtEpochMs: number;
        reason: string;
    }
>;

export type WebSocketTicketLocalRateLimitConfig = Readonly<{
    windowMs: number;
    maxRequests: number;
}>;

export type WebSocketTicketCircuitBreakerConfig = Readonly<{
    maxConsecutiveFailures: number;
    resetTimeoutMs: number;
    halfOpenTimeoutMs: number;
    slidingWindowMs: number;
}>;

const DEFAULT_WS_TICKET_429_BACKOFF_MS = 5_000;
const DEFAULT_WS_TICKET_LOCAL_RATE_LIMIT: WebSocketTicketLocalRateLimitConfig = {
    windowMs: 60_000,
    maxRequests: 30
};
const DEFAULT_WS_TICKET_CIRCUIT_BREAKER: WebSocketTicketCircuitBreakerConfig = {
    maxConsecutiveFailures: 2,
    resetTimeoutMs: 10_000,
    halfOpenTimeoutMs: 10_000,
    slidingWindowMs: 10_000
};
const WS_TICKET_LOCAL_RATE_LIMIT_REASON = 'WebSocket ticket request suppressed by local client rate limiter.';
const WS_TICKET_CIRCUIT_OPEN_REASON = 'WebSocket ticket request suppressed by local circuit breaker.';

let webSocketTicketBackoffState: WebSocketTicketBackoffState = { status: 'idle' };
let webSocketTicketLocalRateLimitConfig = DEFAULT_WS_TICKET_LOCAL_RATE_LIMIT;
const webSocketTicketLocalLimiters = new Map<string, RateLimiter>();
let webSocketTicketCircuitBreakerConfig = DEFAULT_WS_TICKET_CIRCUIT_BREAKER;
let webSocketTicketCircuitBreaker = createWebSocketTicketCircuitBreaker(
    webSocketTicketCircuitBreakerConfig
);

type WebSocketTicketAttempt = Readonly<
    | { kind: 'ok'; ticket: WebSocketTicketResponse; }
    | { kind: 'http-error'; error: ApiHttpError; }
    | { kind: 'error'; error: Error; }
>;

export function readWebSocketTicketBackoffState(): WebSocketTicketBackoffState {
    return webSocketTicketBackoffState;
}

export function resetWebSocketTicketBackoff(): void {
    webSocketTicketBackoffState = { status: 'idle' };
    webSocketTicketLocalLimiters.clear();
    webSocketTicketCircuitBreaker = createWebSocketTicketCircuitBreaker(
        webSocketTicketCircuitBreakerConfig
    );
}

export function configureWebSocketTicketLocalRateLimit(
    config: WebSocketTicketLocalRateLimitConfig
): void {
    webSocketTicketLocalRateLimitConfig = config;
    webSocketTicketLocalLimiters.clear();
}

export function configureWebSocketTicketCircuitBreaker(
    config: WebSocketTicketCircuitBreakerConfig
): void {
    webSocketTicketCircuitBreakerConfig = config;
    webSocketTicketCircuitBreaker = createWebSocketTicketCircuitBreaker(config);
}

export async function createWebSocketTicket(
    options: ApiMutationRequestOptions
): Promise<WebSocketTicketResponse> {
    const now = Date.now();
    if (
        webSocketTicketBackoffState.status === 'cooldown' &&
        webSocketTicketBackoffState.retryAtEpochMs > now
    ) {
        throw new ApiHttpError(
            'POST',
            '/api/auth/ws-ticket',
            429,
            'WebSocket ticket request suppressed until cooldown expires.'
        );
    }
    if (!webSocketTicketCircuitBreaker.isAllowedThrough()) {
        markWebSocketTicketCircuitOpen();
        throw new ApiHttpError('POST', '/api/auth/ws-ticket', 503, WS_TICKET_CIRCUIT_OPEN_REASON);
    }

    try {
        const session = options.authSession === undefined ? readSession() : options.authSession;
        const limiterKey = session?.sessionId ?? 'anonymous';
        const ticket = await RateLimiter.tryToExecuteOrElse<WebSocketTicketResponse>(
            readWebSocketTicketLocalLimiter(limiterKey),
            () => createWebSocketTicketThroughCircuitBreaker(options),
            rejectWebSocketTicketLocalRateLimit
        );
        webSocketTicketBackoffState = { status: 'idle' };
        return ticket;
    }
    catch (error) {
        if (
            error instanceof ApiHttpError &&
            error.status === 429 &&
            error.bodyText !== WS_TICKET_LOCAL_RATE_LIMIT_REASON
        ) {
            const failedAt = Date.now();
            webSocketTicketBackoffState = {
                status: 'cooldown',
                retryAtEpochMs: failedAt + readRetryAfterMs(error.headers, failedAt),
                lastStatus: 429,
                lastFailureAtEpochMs: failedAt,
                reason: error.bodyText
            };
        }
        throw error;
    }
}

function createWebSocketTicketCircuitBreaker(
    config: WebSocketTicketCircuitBreakerConfig
): CircuitBreaker {
    return CircuitBreaker.create(
        new CircuitBreakerPolicy(
            config.maxConsecutiveFailures,
            Temporal.Duration.from({ milliseconds: config.resetTimeoutMs }),
            Temporal.Duration.from({ milliseconds: config.halfOpenTimeoutMs }),
            Temporal.Duration.from({ milliseconds: config.slidingWindowMs })
        )
    );
}

function readWebSocketTicketLocalLimiter(sessionId: string): RateLimiter {
    const existing = webSocketTicketLocalLimiters.get(sessionId);
    if (existing) {
        return existing;
    }
    const limiter = RateLimiter.init(
        webSocketTicketLocalRateLimitConfig.windowMs,
        webSocketTicketLocalRateLimitConfig.maxRequests
    );
    webSocketTicketLocalLimiters.set(sessionId, limiter);
    return limiter;
}

function readRetryAfterMs(headers: Headers | undefined, nowMs: number): number {
    const raw = headers?.get('retry-after');
    if (!raw) {
        return DEFAULT_WS_TICKET_429_BACKOFF_MS;
    }
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.max(0, seconds * 1_000);
    }
    const retryAt = Date.parse(raw);
    return Number.isFinite(retryAt)
        ? Math.max(0, retryAt - nowMs)
        : DEFAULT_WS_TICKET_429_BACKOFF_MS;
}

async function executeWebSocketTicketAttempt(
    options: ApiMutationRequestOptions
): Promise<WebSocketTicketAttempt> {
    try {
        return {
            kind: 'ok',
            ticket: await executeHttpRequest<Record<string, never>, WebSocketTicketResponse>(
                readApiBaseUrl(),
                toApiMutationRequestPath('/api/auth/ws-ticket', options.requestId),
                'POST',
                {},
                options
            )
        };
    }
    catch (error) {
        if (error instanceof ApiHttpError) {
            return { kind: 'http-error', error };
        }
        return {
            kind: 'error',
            error: error instanceof Error ? error : new Error(String(error))
        };
    }
}

function isSuccessfulWebSocketTicketAttempt(attempt: WebSocketTicketAttempt): boolean {
    if (attempt.kind === 'ok') {
        return true;
    }
    if (attempt.kind === 'http-error') {
        return attempt.error.status < 500;
    }
    return attempt.error.name === 'AbortError';
}

function throwWebSocketTicketAttempt(attempt: WebSocketTicketAttempt): never {
    if (attempt.kind === 'ok') {
        throw new Error('Cannot throw a successful WebSocket ticket attempt.');
    }
    throw attempt.error;
}

function readWebSocketTicketAttemptStatus(attempt: WebSocketTicketAttempt): number {
    return attempt.kind === 'http-error' ? attempt.error.status : 503;
}

function markWebSocketTicketCircuitOpen(lastStatus: number = 503): void {
    webSocketTicketBackoffState = {
        status: 'circuit-open',
        lastStatus,
        lastFailureAtEpochMs: Date.now(),
        reason: WS_TICKET_CIRCUIT_OPEN_REASON
    };
}

async function rejectWebSocketTicketLocalRateLimit(): Promise<WebSocketTicketResponse> {
    webSocketTicketBackoffState = {
        status: 'local-rate-limited',
        lastStatus: 429,
        lastFailureAtEpochMs: Date.now(),
        reason: WS_TICKET_LOCAL_RATE_LIMIT_REASON
    };
    throw new ApiHttpError('POST', '/api/auth/ws-ticket', 429, WS_TICKET_LOCAL_RATE_LIMIT_REASON);
}

async function createWebSocketTicketThroughCircuitBreaker(
    options: ApiMutationRequestOptions
): Promise<WebSocketTicketResponse> {
    const result = await CircuitBreaker.tryToExecute<WebSocketTicketAttempt>(
        webSocketTicketCircuitBreaker,
        () => executeWebSocketTicketAttempt(options),
        isSuccessfulWebSocketTicketAttempt
    );
    return result.fold(
        () => {
            markWebSocketTicketCircuitOpen();
            throw new ApiHttpError(
                'POST',
                '/api/auth/ws-ticket',
                503,
                WS_TICKET_CIRCUIT_OPEN_REASON
            );
        },
        (attempt) => {
            if (attempt.kind === 'ok') {
                return attempt.ticket;
            }
            if (
                !isSuccessfulWebSocketTicketAttempt(attempt) &&
                webSocketTicketCircuitBreaker.isOpen()
            ) {
                markWebSocketTicketCircuitOpen(readWebSocketTicketAttemptStatus(attempt));
            }
            throwWebSocketTicketAttempt(attempt);
        }
    );
}
