import type { RallarApiClientConfig } from '@shared-web/browser/api-client-config.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarPeopleState } from '@shared-web/browser/rallar-people-facade.ts';
import type { RallarRoomState } from '@shared-web/browser/rallar-rooms-facade.ts';
import type { RallarBrowserRuntimeDefaults } from '@shared-web/browser/rallar-runtime-context.ts';
import type { RallarSubscriptionScope } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type {
    CommandsOrchestrator,
    CommandsOrchestratorPolicies,
} from '@shared/cache/CommandsOrchestrator.ts';

export type RallarConnectStatus = 'idle' | 'connecting' | 'connected';

export type RallarFlow<K, V> = CommandsOrchestrator<K, V>;

export type RallarFlowPolicies<V> = CommandsOrchestratorPolicies<V>;

export type RallarDefaults = RallarBrowserRuntimeDefaults;

export type RallarScopedOperationOptions =
    & RallarOperationOptions
    & Readonly<{
    scope?: StateScope;
}>;

export type RallarRefreshOptions = RallarScopedOperationOptions;

export type RallarStartOptions =
    & RallarScopedOperationOptions
    & Readonly<{
    restoreSession?: boolean;
    connect?: boolean;
    refreshRooms?: boolean;
    refreshPeople?: boolean;
}>;

export type RallarStartResult = Readonly<{
    session?: AuthSession;
    connected: boolean;
    middleware?: ApiMiddleware;
    roomState?: RallarRoomState;
    peopleState?: RallarPeopleState;
}>;

export type RallarSetupInput =
    & RallarApiClientConfig
    & RallarDefaults
    & Readonly<{
    start?: RallarStartOptions;
}>;

export type RallarConnectionFacade = Readonly<{
    configure(config: RallarApiClientConfig): void;
    setDefaults(defaults?: RallarDefaults): void;
    defaults(): RallarDefaults | undefined;
    connect(options?: RallarScopedOperationOptions): Promise<ApiMiddleware>;
    start(options?: RallarStartOptions): Promise<RallarStartResult>;
    disconnect(): Promise<void>;
    status(): RallarConnectStatus;
    isConnected(): boolean;
    session(): AuthSession | undefined;
    subscriptions(): RallarSubscriptionScope;
    flow<K, V>(policies?: RallarFlowPolicies<V>): RallarFlow<K, V>;
}>;

export type CreateRallarConnectionFacadeOptions = RallarConnectionFacade;

export function createRallarConnectionFacade(
    operations: CreateRallarConnectionFacadeOptions,
): RallarConnectionFacade {
    return {
        configure: (config): void => operations.configure(config),
        setDefaults: (defaults): void => operations.setDefaults(defaults),
        defaults: (): RallarDefaults | undefined => operations.defaults(),
        connect: async (options = {}): Promise<ApiMiddleware> =>
            await operations.connect(options),
        start: async (options = {}): Promise<RallarStartResult> =>
            await operations.start(options),
        disconnect: async (): Promise<void> => await operations.disconnect(),
        status: (): RallarConnectStatus => operations.status(),
        isConnected: (): boolean => operations.isConnected(),
        session: (): AuthSession | undefined => operations.session(),
        subscriptions: (): RallarSubscriptionScope => operations.subscriptions(),
        flow: <K, V>(
            policies: RallarFlowPolicies<V> = {},
        ): RallarFlow<K, V> => operations.flow<K, V>(policies),
    };
}
