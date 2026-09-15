import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    RallarBlackBoxTestCommandContext
} from '../rallar-black-box-test-contracts.ts';

import { createBrowserCommandAbortScope, withBrowserCommandAbort } from './browser-command-cancellation.ts';
import {
    CommandWithId,
    RallarBlackBoxBrowserRallarRuntime,
    RallarBlackBoxBrowserWebSocketFactory
} from './browser-command-contracts.ts';
import { requiresAuthSessionPlaceholder } from './browser-command-placeholders.ts';
import { toRallarAuthConnectionConfig } from './browser-rallar-command-input.ts';

export interface BrowserCommandEnvironment {
    readonly rallarRuntime: RallarBlackBoxBrowserRallarRuntime | undefined;
    readonly fetch: typeof fetch | undefined;
    readonly webSocketFactory: RallarBlackBoxBrowserWebSocketFactory | undefined;
    readonly defaultWsOpenTimeoutMs: number;
    readonly defaultHttpBodyLimit: number;
    readonly now: () => number;
    readonly readSession: () => AuthSession | undefined;
    readonly requestId: () => string;
}
export function requireBrowserCommandRuntime(
    environment: BrowserCommandEnvironment
): RallarBlackBoxBrowserRallarRuntime {
    if (!environment.rallarRuntime) {
        throw new Error('Rallar browser runtime is not configured.');
    }
    return environment.rallarRuntime;
}
export function requireBrowserCommandFetch(environment: BrowserCommandEnvironment): typeof fetch {
    if (!environment.fetch) {
        throw new Error('fetch is not available for http.request.');
    }
    return environment.fetch;
}
export function requireBrowserWebSocketFactory(
    environment: BrowserCommandEnvironment
): RallarBlackBoxBrowserWebSocketFactory {
    if (!environment.webSocketFactory) {
        throw new Error('WebSocket is not available for ws commands.');
    }
    return environment.webSocketFactory;
}

export async function readBrowserCommandAuthSession(
    input: BrowserCommandAuthInput,
    environment: BrowserCommandEnvironment
): Promise<AuthSession | undefined> {
    const { value, command, context, required } = input;
    const config = context.config();
    let session = environment.readSession();
    const needsSession = required || requiresAuthSessionPlaceholder(value);
    if (session || !needsSession || !environment.rallarRuntime) {
        return session;
    }

    const abort = createBrowserCommandAbortScope(command, context, environment.now);
    try {
        const connectionConfig = toRallarAuthConnectionConfig(config);
        await withBrowserCommandAbort(
            environment.rallarRuntime.authenticate(connectionConfig),
            abort.signal
        );
    }
    finally {
        abort.cleanup();
    }

    session = environment.readSession();
    return session;
}
export interface BrowserCommandAuthInput {
    readonly value: unknown;
    readonly command: CommandWithId;
    readonly context: RallarBlackBoxTestCommandContext;
    readonly required: boolean;
}
