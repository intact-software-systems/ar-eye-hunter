import type { RallarDefaults } from '@shared-web/browser/rallar-connection-facade.ts';
import type { AuthSession, LoginResponse } from '@shared/api/api-config.ts';
import type {
    BlackBoxRallarCloseDiagnostics,
    BlackBoxRallarConnectDiagnostics,
    BlackBoxRallarConnectionConfig
} from '../black-box-rallar-operation-contracts.ts';
import type { BlackBoxBrowserRallarRuntimeDependency } from '../browser-rallar-runtime-composition.ts';
import type { BlackBoxRallarLifecycleController } from '../lifecycle-controller.ts';

export namespace BlackBoxRallarConnectionState {
    export type Session = Pick<AuthSession, 'clientId' | 'sessionId' | 'username'>;

    export type Lifecycle = BlackBoxRallarLifecycleController<
        BlackBoxRallarConnectionConfig,
        LoginResponse | AuthSession,
        BlackBoxRallarConnectDiagnostics,
        BlackBoxRallarCloseDiagnostics
    >;

    export interface Configuration {
        readonly defaults: RallarDefaults | undefined;
        readonly config: BlackBoxRallarConnectionConfig;
        readonly almDiagnostics: boolean;
    }

    /** Each unsubscribe is present only when the connection transport installed that subscription. */
    export interface Value {
        readonly config: BlackBoxRallarConnectionConfig;
        readonly session: Session;
        readonly unsubscribeRealtime?: () => void;
        readonly unsubscribeMessagesRtc?: () => void;
        readonly unsubscribeWsLifecycle?: () => void;
        readonly unsubscribeRtcLifecycle?: () => void;
        readonly unsubscribeFormationDiagnostics?: () => void;
        readonly unsubscribeConsoleDiagnostics?: () => void;
    }
}

export class BlackBoxRallarConnectionState {
    #value: BlackBoxRallarConnectionState.Value | undefined;
    #configuration: BlackBoxRallarConnectionState.Configuration | undefined;
    #configurationCompletion: BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion | undefined;

    configuration(): BlackBoxRallarConnectionState.Configuration | undefined {
        return this.#configuration;
    }

    recordConfiguration(configuration: BlackBoxRallarConnectionState.Configuration): void {
        this.#configuration = configuration;
        this.#configurationCompletion = undefined;
    }

    /** Bind prepared policy once; reuse must retain the originating middleware's ownership proof. */
    bindConfiguration(completion: BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion): void {
        this.#configurationCompletion ??= completion;
    }

    verifiedConfiguration(): BlackBoxRallarConnectionState.Configuration | undefined {
        return this.#configurationCompletion && this.#configurationCompletion.captureOwnershipFailure() === undefined
            ? this.#configuration
            : undefined;
    }

    get(): BlackBoxRallarConnectionState.Value | undefined {
        return this.#value;
    }

    set(value: BlackBoxRallarConnectionState.Value | undefined): void {
        this.#value = value;
        if (value === undefined) {
            this.#configuration = undefined;
            this.#configurationCompletion = undefined;
        }
    }
}
