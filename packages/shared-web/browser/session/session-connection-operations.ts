import {
    configureApiClient,
    normalizeApiBaseUrl,
    readApiBaseUrl,
    type RallarApiClientConfig
} from '@shared-web/browser/api-client-config.ts';
import type { RallarConnectionRuntimePort } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
import type { BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type {
    RallarConnectionOperations,
    RallarDeadlineAuthority,
    RallarDefaults
} from '@shared-web/browser/rallar-connection-facade.ts';
import { readSession } from '@shared/api/auth.ts';
import { CommandsOrchestrator } from '@shared/cache/CommandsOrchestrator.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';

import type { RallarSessionAuthLifecycle } from './session-auth-lifecycle.ts';

export interface CreateRallarSessionConnectionOperationsInput {
    readonly connectionRuntime: RallarConnectionRuntimePort;
    readonly transportRuntime: BrowserTransportRuntimePort;
    readonly authLifecycle: RallarSessionAuthLifecycle;
}

export function createRallarSessionConnectionOperations(
    input: CreateRallarSessionConnectionOperationsInput
): RallarConnectionOperations {
    return {
        configure: (config) => configureRallarApiClient(input, config),
        setDefaults: (defaults?: RallarDefaults) => input.connectionRuntime.setDefaults(defaults),
        defaults: () => input.connectionRuntime.defaults(),
        connect: (options) => input.authLifecycle.connect(options),
        disconnect: () => input.authLifecycle.disconnect(),
        deadlineAfter(durationMs, authority) {
            if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
                throw new RangeError('Duration must be a nonnegative safe integer in milliseconds.');
            }
            const offset = readMaxAuthorityOffsetMs(authority);
            const window = input.connectionRuntime.readMiddleware()?.serverTime.readWindow().right;
            if (window === undefined) {
                return undefined;
            }
            const deadline = window.latestEpochMs + offset + durationMs;
            if (!Number.isSafeInteger(deadline)) {
                throw new RangeError('Deadline exceeds the supported epoch range.');
            }
            return deadline;
        },
        compareDeadline(deadlineEpochMs, authority) {
            if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs < 0) {
                throw new RangeError('Deadline must be a nonnegative safe integer epoch in milliseconds.');
            }
            const offset = readMaxAuthorityOffsetMs(authority);
            const window = input.connectionRuntime.readMiddleware()?.serverTime.readWindow().right;
            if (window === undefined) {
                return 'unavailable';
            }
            if (deadlineEpochMs - window.latestEpochMs > offset) {
                return 'before';
            }
            return window.earliestEpochMs - deadlineEpochMs >= offset ? 'at-or-after' : 'overlaps';
        },
        schedulePosition(schedule, authority) {
            const offset = readMaxAuthorityOffsetMs(authority);
            const window = input.connectionRuntime.readMiddleware()?.serverTime.readWindow().right;
            if (!window) return { status: 'unavailable' };
            let current = null;
            for (const phase of schedule.phases) {
                if (phase.startsAtEpochMs - window.latestEpochMs > offset) {
                    return { status: 'current', current, next: phase };
                }
                if (window.earliestEpochMs - phase.startsAtEpochMs < offset) return { status: 'uncertain' };
                current = phase;
            }
            return { status: 'current', current, next: null };
        },
        rtcCapture: () => input.transportRuntime.readRtcCaptureReceipt(),
        status: () => input.connectionRuntime.readConnectState(),
        isConnected: () =>
            input.connectionRuntime.readConnectState() === 'connected' &&
            input.connectionRuntime.readMiddleware() !== undefined,
        session: readSession,
        serverPeerId: () => input.connectionRuntime.readMiddleware()?.middleware.webSocketQueueBox.serverPeerId,
        subscriptions: () => new SubscriptionScope(),
        flow: <K, V>(policies = {}) => CommandsOrchestrator.withPolicies<K, V>(policies)
    };
}

function readMaxAuthorityOffsetMs(authority: RallarDeadlineAuthority | undefined): number {
    if (authority === undefined) {
        return 0;
    }
    const { maxAuthorityOffsetMs } = authority;
    if (!Number.isSafeInteger(maxAuthorityOffsetMs) || maxAuthorityOffsetMs < 0) {
        throw new RangeError('Authority offset bound must be a nonnegative safe integer in milliseconds.');
    }
    return maxAuthorityOffsetMs;
}

function configureRallarApiClient(
    input: CreateRallarSessionConnectionOperationsInput,
    config: RallarApiClientConfig
): void {
    const nextApiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl ?? '');
    const isChanging = nextApiBaseUrl !== readApiBaseUrl();
    if (
        isChanging &&
        (input.connectionRuntime.readMiddleware() ||
            input.transportRuntime.isReady() ||
            input.transportRuntime.isInitializing())
    ) {
        throw new Error('Rallar must be configured before connecting.');
    }
    configureApiClient({ apiBaseUrl: nextApiBaseUrl });
}
