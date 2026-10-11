import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
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
        readonly diagnosticsPorts: RallarDiagnosticsPorts | undefined;
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

    /** Verify consumed publication ports and current ownership before binding the originating middleware. */
    bindConfiguration(completion: BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion): boolean | undefined {
        const configuration = this.#configuration;
        if (
            !configuration || completion.captureOwnershipFailure() !== undefined ||
            !matchesAlmRecordingPorts(configuration.diagnosticsPorts, completion.diagnosticsPorts) ||
            (this.#configurationCompletion !== undefined && this.verifiedConfiguration() === undefined)
        ) {
            throw new Error(
                'ALM recording policy is unverified for the acquired SDK connection; close and reinitialize before configuring.'
            );
        }
        this.#configurationCompletion ??= completion;
        return configuration.diagnosticsPorts === undefined ? undefined : configuration.almDiagnostics;
    }

    verifiedConfiguration(): BlackBoxRallarConnectionState.Configuration | undefined {
        return this.#configuration && this.#configurationCompletion &&
                this.#configurationCompletion.captureOwnershipFailure() === undefined &&
                matchesAlmRecordingPorts(
                    this.#configuration.diagnosticsPorts,
                    this.#configurationCompletion.diagnosticsPorts
                )
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

/** Unscoped default clearing installs no harness ports and certifies no ALM selection. */
function matchesAlmRecordingPorts(
    prepared: RallarDiagnosticsPorts | undefined,
    consumed: RallarDiagnosticsPorts
): boolean {
    return prepared === undefined || (
        prepared.outboundDiagnostics === consumed.outboundDiagnostics &&
        prepared.inboundDiagnostics === consumed.inboundDiagnostics &&
        prepared.storage === consumed.storage
    );
}
