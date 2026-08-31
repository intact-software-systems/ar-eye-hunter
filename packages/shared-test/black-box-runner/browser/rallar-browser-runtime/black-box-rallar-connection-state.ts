import type { AuthSession } from '@shared/api/api-config.ts';
import type { BlackBoxRallarConnectionConfig } from './contracts.ts';
export namespace BlackBoxRallarConnectionState {
    export type Session = Pick<AuthSession, 'clientId' | 'sessionId' | 'username'>;
    export interface Value {
        readonly config: BlackBoxRallarConnectionConfig;
        readonly session: Session;
        readonly unsubscribeRealtime?: () => void;
        readonly unsubscribeMessagesRtc?: () => void;
        readonly unsubscribeWsLifecycle?: () => void;
        readonly unsubscribeRtcLifecycle?: () => void;
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
