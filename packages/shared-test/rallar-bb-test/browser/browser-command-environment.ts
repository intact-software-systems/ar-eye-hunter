import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxTestCommandContext } from '../rallar-black-box-test-contracts.ts';

import { createBrowserCommandAbortScope, withBrowserCommandAbort } from './browser-command-cancellation.ts';
import type {
    CommandWithId,
    RallarBlackBoxBrowserRallarRuntime,
    RallarBlackBoxBrowserWebSocketFactory
} from './browser-command-contracts.ts';
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

export interface BrowserCommandAuthInput {
    readonly command: CommandWithId;
    readonly context: RallarBlackBoxTestCommandContext;
    /** True when the command names a Rallar path or an auth placeholder. */
    readonly required: boolean;
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
    const session = environment.readSession();
    if (session || !input.required || !environment.rallarRuntime) {
        return session;
    }

    const abort = createBrowserCommandAbortScope(input.command, input.context, environment.now);
    try {
        await withBrowserCommandAbort(
            environment.rallarRuntime.authenticate(toRallarAuthConnectionConfig(input.context.config())),
            abort.signal
        );
    }
    finally {
        abort.cleanup();
    }
    return environment.readSession();
}
