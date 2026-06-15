import type { AuthSession } from '@shared/api/api-config.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarApiClientConfig } from '@shared-web/browser/api-client-config.ts';
import type {
    RallarConnectStatus,
    RallarDefaults,
    RallarFlow,
    RallarFlowPolicies,
    RallarScopedOperationOptions,
    RallarStartOptions,
    RallarStartResult,
    RallarSubscriptionScope,
} from '@shared-web/browser/rallar.ts';

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
