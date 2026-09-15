import type { AuthSession, LoginResponse } from '@shared/api/api-config.ts';
import type {
    BlackBoxRallarCloseDiagnostics,
    BlackBoxRallarConnectDiagnostics,
    BlackBoxRallarConnectionConfig
} from '../black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarLifecycleController } from '../lifecycle-controller.ts';

export namespace BlackBoxRallarConnectionState {
    export type Session = Pick<AuthSession, 'clientId' | 'sessionId' | 'username'>;

    export type Lifecycle = BlackBoxRallarLifecycleController<
        BlackBoxRallarConnectionConfig,
        LoginResponse | AuthSession,
        BlackBoxRallarConnectDiagnostics,
        BlackBoxRallarCloseDiagnostics
    >;

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

    get(): BlackBoxRallarConnectionState.Value | undefined {
        return this.#value;
    }

    set(value: BlackBoxRallarConnectionState.Value | undefined): void {
        this.#value = value;
    }
}
