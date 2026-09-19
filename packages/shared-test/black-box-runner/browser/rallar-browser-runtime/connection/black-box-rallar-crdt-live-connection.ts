import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import type { RallarCrdtTransportStrategy } from '@shared/crdt/mod.ts';

import type { BlackBoxRallarRuntimeDiagnostics } from '../black-box-rallar-diagnostics.ts';
import type { BlackBoxRallarConnectionConfig } from '../black-box-rallar-operation-contracts.ts';
import { blackBoxRallarConnectionOperationKeyOf, blackBoxRallarScopeOf } from '../black-box-rallar-operation-policy.ts';
import type { BlackBoxBrowserRallarRuntimeDependency } from '../browser-rallar-runtime-composition.ts';
import type { BlackBoxRallarLifecycleOperationContext } from '../lifecycle-controller.ts';
import type { BlackBoxRallarAuthentication } from './black-box-rallar-authentication.ts';
import { toBlackBoxRallarSessionDiagnostic, toConnectedTargetRejection } from './black-box-rallar-connection-policy.ts';
import type { BlackBoxRallarConnectionState } from './black-box-rallar-connection-state.ts';
import { configureBlackBoxRallarConnection } from './configure-black-box-rallar-connection.ts';

export namespace BlackBoxRallarCrdtLiveConnection {
    export interface Input {
        readonly rallar: BlackBoxBrowserRallarRuntimeDependency;
        readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
        readonly diagnosticsPorts: RallarDiagnosticsPorts;
        readonly lifecycle: BlackBoxRallarConnectionState.Lifecycle;
        readonly connectionState: BlackBoxRallarConnectionState;
        readonly authentication: BlackBoxRallarAuthentication;
    }
}

export class BlackBoxRallarCrdtLiveConnection {
    readonly #input: BlackBoxRallarCrdtLiveConnection.Input;

    constructor(input: BlackBoxRallarCrdtLiveConnection.Input) {
        this.#input = input;
    }

    ensure = async (
        config: BlackBoxRallarConnectionConfig,
        transportStrategy: RallarCrdtTransportStrategy
    ): Promise<void> => {
        const { lifecycle, connectionState } = this.#input;
        const activeAuthentication = lifecycle.authenticationConfig();
        if (activeAuthentication) {
            await lifecycle.waitForAuthentication();
            return await this.ensure(config, transportStrategy);
        }
        const rejection = toConnectedTargetRejection(connectionState.get(), config);
        if (rejection) {
            throw rejection;
        }
        await lifecycle.runExclusive(
            'crdt-live:' + blackBoxRallarConnectionOperationKeyOf(config),
            (context) => this.#open(config, transportStrategy, context)
        );
    };

    async #open(
        config: BlackBoxRallarConnectionConfig,
        transportStrategy: RallarCrdtTransportStrategy,
        context: BlackBoxRallarLifecycleOperationContext
    ): Promise<void> {
        const { rallar, diagnostics } = this.#input;
        const queuedRejection = toConnectedTargetRejection(this.#input.connectionState.get(), config);
        if (queuedRejection) {
            throw queuedRejection;
        }
        diagnostics.emitDiagnostic(config, 'rallar.browser.crdt.configure_started', { transportStrategy });
        const defaults = configureBlackBoxRallarConnection({
            rallar,
            diagnosticsPorts: this.#input.diagnosticsPorts,
            config
        });
        diagnostics.emitDiagnostic(config, 'rallar.browser.crdt.configure_completed', { defaults });
        if (rallar.isConnected()) {
            return;
        }
        const session = await this.#input.authentication.sessionForAuthentication(config);
        context.assertCurrent();
        await rallar.connect({ timeoutMs: config.rallar.timeoutMs });
        context.assertCurrent();
        if (config.roomId) {
            await rallar.rooms.join(config.roomId, {
                timeoutMs: config.rallar.timeoutMs,
                scope: blackBoxRallarScopeOf(config)
            });
            context.assertCurrent();
        }
        diagnostics.emitDiagnostic(config, 'rallar.browser.crdt.connected', {
            session: toBlackBoxRallarSessionDiagnostic(session),
            transportStrategy
        });
    }
}
