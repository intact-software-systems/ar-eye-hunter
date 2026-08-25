import {
    configureApiClient,
    normalizeApiBaseUrl,
    readApiBaseUrl,
    type RallarApiClientConfig
} from '@shared-web/browser/api-client-config.ts';
import type { BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { RallarConnectionOperations, RallarDefaults } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarConnectionRuntimePort } from '@shared-web/browser/rallar-runtime-context.ts';
import { BrowserRallarSubscriptionScope } from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import { readSession } from '@shared/api/auth.ts';
import { CommandsOrchestrator } from '@shared/cache/CommandsOrchestrator.ts';

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
        status: () => input.connectionRuntime.readConnectState(),
        isConnected: () =>
            input.connectionRuntime.readConnectState() === 'connected' &&
            input.connectionRuntime.readMiddleware() !== undefined,
        session: readSession,
        subscriptions: () => new BrowserRallarSubscriptionScope(),
        flow: <K, V>(policies = {}) => CommandsOrchestrator.withPolicies<K, V>(policies)
    };
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
