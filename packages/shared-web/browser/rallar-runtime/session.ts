import type {
    ApiMiddleware,
    BrowserTransportRuntimePort
} from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type {
    RallarConnectionOperations,
    RallarDefaults,
    RallarScopedOperationOptions
} from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type {
    RallarAuthRuntimePort,
    RallarBrowserFacadeRuntimeContext,
    RallarConnectionRuntimePort
} from '@shared-web/browser/rallar-runtime-context.ts';
import type { RallarLifecycleCoordinator } from '@shared-web/browser/rallar-runtime/lifecycle.ts';
import { BrowserSessionAuthOperations } from '@shared-web/browser/session/browser-session-auth-operations.ts';
import type { RallarAuthFacade } from '@shared-web/browser/session/rallar-auth-facade.ts';
import { BrowserSessionAuthLifecycle } from '@shared-web/browser/session/session-auth-lifecycle.ts';
import { BrowserSessionConnectionLifecycle } from '@shared-web/browser/session/session-connection-lifecycle.ts';
import { createRallarSessionConnectionOperations } from '@shared-web/browser/session/session-connection-operations.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';

export interface CreateRallarSessionControllerOptions {
    readonly connectionRuntime: RallarConnectionRuntimePort;
    readonly transportRuntime: BrowserTransportRuntimePort;
    readonly authRuntime: RallarAuthRuntimePort;
    readonly stateRuntime: Pick<RallarBrowserFacadeRuntimeContext, 'clearCurrentRoom'>;
    readonly lifecycle: RallarLifecycleCoordinator;
    readonly emitState: () => void;
    readonly closeDataScopes: (session: AuthSession) => Promise<void>;
}

export interface RallarSessionController {
    readonly connectionOperations: RallarConnectionOperations;
    readonly auth: RallarAuthFacade;
    connect(options?: RallarScopedOperationOptions): Promise<ApiMiddleware>;
    disconnect(): Promise<void>;
    readMiddleware(): ApiMiddleware | undefined;
    requireMiddleware(): ApiMiddleware;
    requireSession(): AuthSession;
    readDefaults(): RallarDefaults | undefined;
    readDefaultScope(): StateScope | undefined;
    resolveOperationOptions<T extends RallarOperationOptions>(
        options: T
    ): T & RallarOperationOptions;
    resolveOperationScope(scope?: StateScope): StateScope | undefined;
    runAuthAwareOperation<T>(operation: () => T | Promise<T>): Promise<T>;
    waitForAuthEnd(): Promise<void>;
}

export function createRallarSessionController(
    options: CreateRallarSessionControllerOptions
): RallarSessionController {
    const connectionLifecycle = new BrowserSessionConnectionLifecycle({
        connectionRuntime: options.connectionRuntime,
        transportRuntime: options.transportRuntime,
        lifecycle: options.lifecycle,
        clearCurrentRoom: options.stateRuntime.clearCurrentRoom
    });
    const authLifecycle = new BrowserSessionAuthLifecycle({
        connectionRuntime: options.connectionRuntime,
        transportRuntime: options.transportRuntime,
        authRuntime: options.authRuntime,
        connectionLifecycle,
        emitState: options.emitState,
        closeDataScopes: options.closeDataScopes
    });
    const connectionOperations = createRallarSessionConnectionOperations({
        connectionRuntime: options.connectionRuntime,
        transportRuntime: options.transportRuntime,
        authLifecycle
    });
    const auth = new BrowserSessionAuthOperations({
        connectionRuntime: options.connectionRuntime,
        authLifecycle
    });

    return {
        connectionOperations,
        auth,
        connect: (connectionOptions) => authLifecycle.connect(connectionOptions),
        disconnect: () => authLifecycle.disconnect(),
        readMiddleware: () => options.connectionRuntime.readMiddleware(),
        requireMiddleware: () => options.connectionRuntime.requireMiddleware(),
        requireSession: () => authLifecycle.requireSession(),
        readDefaults: () => options.connectionRuntime.readDefaults(),
        readDefaultScope: () => options.connectionRuntime.readDefaultScope(),
        resolveOperationOptions: (operationOptions) =>
            options.connectionRuntime.resolveOperationOptions(operationOptions),
        resolveOperationScope: (scope) => options.connectionRuntime.resolveOperationScope(scope),
        runAuthAwareOperation: (operation) => authLifecycle.runAuthAwareOperation(operation),
        waitForAuthEnd: () => authLifecycle.waitForAuthEnd()
    };
}
