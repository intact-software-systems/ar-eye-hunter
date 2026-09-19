import { toError } from '@shared/resilience/to-error.ts';

import type { BlackBoxRallarCrdtController } from '../black-box-rallar-crdt-controller.ts';
import type {
    BlackBoxRallarConsoleDiagnostics,
    BlackBoxRallarRuntimeDiagnostics
} from '../black-box-rallar-diagnostics.ts';
import type {
    BlackBoxRallarCloseDiagnostics,
    BlackBoxRallarConnectionConfig
} from '../black-box-rallar-operation-contracts.ts';
import {
    blackBoxRallarRoomRefOf,
    blackBoxRallarScopeDiagnosticsOf,
    blackBoxRallarScopeOf,
    mergeBlackBoxRallarAuthenticationConfig
} from '../black-box-rallar-operation-policy.ts';
import {
    toBlackBoxRallarSerializedError,
    type BlackBoxRallarSerializedError
} from '../black-box-rallar-serialized-error.ts';
import type { BlackBoxBrowserRallarRuntimeDependency } from '../browser-rallar-runtime-composition.ts';
import type { BlackBoxRallarDirectorController } from '../director-controller.ts';
import type { BlackBoxRallarLifecycleCloseContext } from '../lifecycle-controller.ts';
import type { BlackBoxRallarAuthentication } from './black-box-rallar-authentication.ts';
import { resolveBlackBoxRallarTransport } from './black-box-rallar-connection-policy.ts';
import type { BlackBoxRallarConnectionState } from './black-box-rallar-connection-state.ts';
import type { BlackBoxRallarConnectionSubscriptions } from './black-box-rallar-connection-subscriptions.ts';

interface TransportCloseResult {
    readonly logout: boolean;
    readonly disconnected: boolean;
}

interface ClosePreparation {
    readonly runtimeState: BlackBoxRallarConnectionState.Value | undefined;
    readonly config: BlackBoxRallarConnectionConfig | undefined;
}

export namespace BlackBoxRallarCloseOperation {
    export interface Input {
        readonly rallar: BlackBoxBrowserRallarRuntimeDependency;
        readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
        readonly lifecycle: BlackBoxRallarConnectionState.Lifecycle;
        readonly connectionState: BlackBoxRallarConnectionState;
        readonly authentication: BlackBoxRallarAuthentication;
        readonly consoleDiagnostics: BlackBoxRallarConsoleDiagnostics<BlackBoxRallarConnectionConfig>;
        readonly crdt: BlackBoxRallarCrdtController;
        readonly director: BlackBoxRallarDirectorController;
        readonly subscriptions: BlackBoxRallarConnectionSubscriptions;
    }
}

export class BlackBoxRallarCloseOperation {
    readonly #input: BlackBoxRallarCloseOperation.Input;
    /** A failed close keeps the config it closed against, so the next close can still reach that target. */
    #retryConfig: BlackBoxRallarConnectionConfig | undefined;

    constructor(input: BlackBoxRallarCloseOperation.Input) {
        this.#input = input;
    }

    close = (): Promise<BlackBoxRallarCloseDiagnostics> => {
        const { connectionState, crdt, authentication } = this.#input;
        const runtimeState = connectionState.get();
        const activeCrdtOpens = crdt.pending();
        const authenticatedConfig = authentication.getConfig();
        return this.#input.lifecycle.close(async (context) => {
            const config = this.#resolveCloseConfig(runtimeState?.config, authenticatedConfig, context);
            this.#retryConfig = config;
            try {
                const diagnostics = await this.#closeResources({ runtimeState, config });
                authentication.clear();
                this.#retryConfig = undefined;
                return diagnostics;
            }
            catch (caught) {
                const error = toError(caught);
                // Cleanup already dropped the subscriptions of this runtime, so it must stop naming the target it tried
                // to leave; the retry config survives so a later close can still reach that target.
                connectionState.set(undefined);
                authentication.clear();
                throw error;
            }
        }, activeCrdtOpens).finally(() => this.#input.rallar.diagnostics.faults.clear());
    };

    #resolveCloseConfig(
        runtimeConfig: BlackBoxRallarConnectionConfig | undefined,
        authenticatedConfig: BlackBoxRallarConnectionConfig | undefined,
        context: BlackBoxRallarLifecycleCloseContext<BlackBoxRallarConnectionConfig>
    ): BlackBoxRallarConnectionConfig | undefined {
        const candidates = [runtimeConfig, authenticatedConfig, context.authenticationConfig, this.#retryConfig]
            .filter((candidate): candidate is BlackBoxRallarConnectionConfig => candidate !== undefined);
        const [baseConfig] = candidates;
        return baseConfig === undefined
            ? undefined
            : candidates.reduce(
                (merged, candidate) => mergeBlackBoxRallarAuthenticationConfig(candidate, merged),
                baseConfig
            );
    }

    async #closeResources(preparation: ClosePreparation): Promise<BlackBoxRallarCloseDiagnostics> {
        const { config } = preparation;
        const { diagnostics } = this.#input;
        const cleanupErrors: BlackBoxRallarSerializedError[] = [];
        try {
            this.#recordCleanupStarted(config);
            const unsubscribed = await this.#stopFeatureResources(preparation, cleanupErrors);
            const leftRoom = await this.#leaveRoom(config, cleanupErrors);
            const { logout, disconnected } = await this.#logoutOrDisconnect(config);
            this.#input.connectionState.set(undefined);
            this.#input.consoleDiagnostics.close();
            const eventContext = {
                connection: config?.connection,
                actor: config?.actor,
                transport: config ? resolveBlackBoxRallarTransport(config) : undefined,
                roomId: config?.roomId,
                ...(config ? blackBoxRallarScopeDiagnosticsOf(config) : {})
            };
            const closed: BlackBoxRallarCloseDiagnostics = {
                status: 'closed',
                ...eventContext,
                unsubscribed,
                leftRoom,
                logout,
                disconnected,
                cleanupErrors
            };
            diagnostics.emit({ kind: 'close', topic: 'rallar.browser.closed', ...eventContext, data: closed });
            return closed;
        }
        catch (caught) {
            const error = toError(caught);
            diagnostics.emitError({ config, topic: 'rallar.browser.close_failed', error });
            throw error;
        }
    }

    async #stopFeatureResources(
        preparation: ClosePreparation,
        cleanupErrors: BlackBoxRallarSerializedError[]
    ): Promise<number> {
        const { runtimeState, config } = preparation;
        let unsubscribed = 0;
        try {
            unsubscribed = this.#input.subscriptions.stop({ state: runtimeState, config });
        }
        catch (caught) {
            const error = toError(caught);
            cleanupErrors.push(toBlackBoxRallarSerializedError(error));
            this.#input.diagnostics.emitError({ config, topic: 'rallar.browser.cleanup.unsubscribe_failed', error });
        }
        for (const error of this.#input.director.closeAll(config)) {
            cleanupErrors.push(toBlackBoxRallarSerializedError(error));
        }
        for (const error of await this.#input.crdt.closeAll(config)) {
            cleanupErrors.push(toBlackBoxRallarSerializedError(error));
        }
        return unsubscribed;
    }

    async #leaveRoom(
        config: BlackBoxRallarConnectionConfig | undefined,
        cleanupErrors: BlackBoxRallarSerializedError[]
    ): Promise<boolean> {
        const { diagnostics } = this.#input;
        if (!config) {
            return false;
        }
        if (!config.roomId || config.rallar.leaveRoomOnClose === false) {
            diagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.room_leave_skipped', {
                roomId: config.roomId,
                leaveRoomOnClose: config.rallar.leaveRoomOnClose
            });
            return false;
        }
        const roomContext = {
            roomId: config.roomId,
            roomRef: blackBoxRallarRoomRefOf(config),
            scope: blackBoxRallarScopeOf(config)
        };
        diagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.room_leave_started', roomContext);
        try {
            await this.#input.rallar.rooms.leave({
                ...roomContext,
                clearCurrent: true,
                timeoutMs: config.rallar.timeoutMs
            });
            diagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.room_leave_completed', roomContext);
            return true;
        }
        catch (caught) {
            const error = toError(caught);
            cleanupErrors.push(toBlackBoxRallarSerializedError(error));
            diagnostics.emitError({
                config,
                topic: 'rallar.browser.cleanup.room_leave_failed',
                error,
                data: roomContext
            });
            return false;
        }
    }

    async #logoutOrDisconnect(config: BlackBoxRallarConnectionConfig | undefined): Promise<TransportCloseResult> {
        const { rallar, diagnostics } = this.#input;
        if (config?.rallar.logoutOnClose) {
            diagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.logout_started');
            await rallar.auth.logout({ timeoutMs: config.rallar.timeoutMs });
            diagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.logout_completed');
            return { logout: true, disconnected: false };
        }
        if (config) {
            diagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.disconnect_started');
        }
        await rallar.disconnect();
        if (config) {
            diagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.disconnect_completed');
        }
        return { logout: false, disconnected: true };
    }

    #recordCleanupStarted(config: BlackBoxRallarConnectionConfig | undefined): void {
        if (!config) {
            return;
        }
        this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.started', {
            roomId: config.roomId,
            ...blackBoxRallarScopeDiagnosticsOf(config),
            logoutOnClose: config.rallar.logoutOnClose === true,
            leaveRoomOnClose: config.rallar.leaveRoomOnClose !== false
        });
    }
}
