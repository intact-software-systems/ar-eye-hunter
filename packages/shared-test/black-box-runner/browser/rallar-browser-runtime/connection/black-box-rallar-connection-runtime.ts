import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import type { RallarRoomTransportStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import { throwRallarValidation } from '@shared/api/rallar-validation.ts';
import type { IndexedDbOperationCounts } from '@shared/persistence/indexed-db-operation-observer.ts';

import { BlackBoxRallarCrdtController } from '../black-box-rallar-crdt-controller.ts';
import {
    BlackBoxRallarRuntimeDiagnostics,
    createBlackBoxRallarConsoleDiagnostics,
    createBlackBoxRallarDiagnosticsPorts,
    type BlackBoxRallarConsoleDiagnostics
} from '../black-box-rallar-diagnostics.ts';
import type { BlackBoxRallarConnectionConfig } from '../black-box-rallar-operation-contracts.ts';
import {
    blackBoxRallarRoomRefOf,
    blackBoxRallarScopeDiagnosticsOf,
    blackBoxRallarScopeOf,
    mergeBlackBoxRallarAuthenticationConfig
} from '../black-box-rallar-operation-policy.ts';
import type {
    BlackBoxRallarRoomRefreshOptions,
    BlackBoxRallarRoomWaitOptions,
    BlackBoxRallarRuntime
} from '../black-box-rallar-runtime-contract.ts';
import type { BlackBoxRallarRuntimeInstallationTarget } from '../black-box-rallar-runtime.ts';
import type { BlackBoxBrowserRallarRuntimeDependency } from '../browser-rallar-runtime-composition.ts';
import { BlackBoxRallarDirectorController } from '../director-controller.ts';
import { BlackBoxRallarFormationController } from '../formation/formation-controller.ts';
import { createBlackBoxRallarLifecycleController } from '../lifecycle-controller.ts';
import { BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES } from '../messaging/black-box-rallar-delivery-error-message-prefixes.ts';
import { BlackBoxRallarDeliveryLedger } from '../messaging/black-box-rallar-delivery-ledger.ts';
import { BlackBoxRallarMessagingController } from '../messaging/black-box-rallar-messaging-controller.ts';
import { BlackBoxRallarTypedChannels } from '../messaging/black-box-rallar-typed-channels.ts';
import {
    createBlackBoxRallarMessagingResourceController,
    type BlackBoxRallarMessagingResourceController
} from '../messaging/create-black-box-rallar-messaging-resource-controller.ts';
import {
    decodeBlackBoxRallarFaultInput,
    decodeBlackBoxRallarStorageCountersInput
} from '../messaging/decode-black-box-rallar-messaging-input.ts';
import { BlackBoxRallarAuthentication } from './black-box-rallar-authentication.ts';
import { BlackBoxRallarCloseOperation } from './black-box-rallar-close-operation.ts';
import { BlackBoxRallarConnectOperation } from './black-box-rallar-connect-operation.ts';
import {
    resolveBlackBoxRallarLaneId,
    resolveBlackBoxRallarTransport,
    toBlackBoxRallarAuthenticationKey,
    toBlackBoxRallarDefaults
} from './black-box-rallar-connection-policy.ts';
import { BlackBoxRallarConnectionState } from './black-box-rallar-connection-state.ts';
import { BlackBoxRallarCrdtLiveConnection } from './black-box-rallar-crdt-live-connection.ts';
import { BlackBoxRallarHealthReader } from './black-box-rallar-health-reader.ts';

export namespace BlackBoxRallarConnectionRuntime {
    export interface Input {
        readonly facade: BlackBoxBrowserRallarRuntimeDependency;
        readonly targetWindow: BlackBoxRallarRuntimeInstallationTarget;
        readonly clock: {
            now(): number;
        };
        readonly delay: (ms: number) => Promise<void>;
    }

    export interface Installation {
        readonly runtime: BlackBoxRallarRuntime;
        emitRuntimeLoaded(): void;
    }

    export interface Foundation {
        readonly rallar: BlackBoxBrowserRallarRuntimeDependency;
        readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
        readonly diagnosticsPorts: RallarDiagnosticsPorts;
        readonly health: BlackBoxRallarHealthReader;
        readonly lifecycle: BlackBoxRallarConnectionState.Lifecycle;
        readonly connectionState: BlackBoxRallarConnectionState;
        readonly authentication: BlackBoxRallarAuthentication;
        readonly consoleDiagnostics: BlackBoxRallarConsoleDiagnostics<BlackBoxRallarConnectionConfig>;
    }

    export interface Controllers {
        readonly crdt: BlackBoxRallarCrdtController;
        readonly director: BlackBoxRallarDirectorController;
        readonly formation: BlackBoxRallarFormationController;
        readonly messagingResources: BlackBoxRallarMessagingResourceController;
        readonly typedChannels: BlackBoxRallarTypedChannels;
        readonly messaging: BlackBoxRallarMessagingController;
        readonly deliveryLedger: BlackBoxRallarDeliveryLedger;
    }
}

export class BlackBoxRallarConnectionRuntime {
    readonly #foundation: BlackBoxRallarConnectionRuntime.Foundation;
    readonly #controllers: BlackBoxRallarConnectionRuntime.Controllers;
    readonly #connectOperation: BlackBoxRallarConnectOperation;
    readonly #closeOperation: BlackBoxRallarCloseOperation;

    constructor(input: BlackBoxRallarConnectionRuntime.Input) {
        this.#foundation = createConnectionFoundation(input);
        this.#controllers = createProductControllers(input, this.#foundation);
        const { crdt, director, formation, typedChannels, messagingResources } = this.#controllers;
        this.#connectOperation = new BlackBoxRallarConnectOperation({
            ...this.#foundation,
            formation,
            typedChannels,
            messagingResources
        });
        this.#closeOperation = new BlackBoxRallarCloseOperation({
            ...this.#foundation,
            crdt,
            director,
            messagingResources
        });
    }

    installation(): BlackBoxRallarConnectionRuntime.Installation {
        const { authentication, diagnostics, rallar } = this.#foundation;
        const { crdt, director, formation, messaging, deliveryLedger } = this.#controllers;
        const runtime: BlackBoxRallarRuntime = {
            authenticate: authentication.authenticate,
            connect: this.#connectOperation.connect,
            send: messaging.send,
            sendWs: messaging.sendWs,
            sendMessage: deliveryLedger.sendMessage,
            observeDelivery: deliveryLedger.observeDelivery,
            cancelDelivery: deliveryLedger.cancelDelivery,
            readReceipts: deliveryLedger.readReceipts,
            injectFault: async (input) => this.#injectFault(input),
            readStorageCounters: async (input) => this.#readStorageCounters(input),
            refreshRoom: async (options) => await this.#refreshRoom(options),
            waitForRoom: async (options) => await this.#waitForRoom(options),
            readRtcMessageNacks: (messageId) => rallar.readRtcMessageNacks(messageId),
            crdt,
            director,
            formation,
            close: this.#closeOperation.close,
            health: async (input = {}) => {
                const config = this.#foundation.connectionState.get()?.config;
                const roomRef = config ? blackBoxRallarRoomRefOf(config) : undefined;
                return await this.#foundation.health.health({
                    input,
                    config,
                    crdt: crdt.summary(),
                    director: director.summary(),
                    // Always present when a room resolves, and handed the resolved ref rather than a room id, so
                    // the one throwing path in the facade is unreachable on the hot paths that call `health`.
                    formation: roomRef ? formation.summary(roomRef) : undefined
                });
            }
        };
        return {
            runtime,
            emitRuntimeLoaded: () => diagnostics.emit({ kind: 'diagnostic', topic: 'rallar.browser.runtime_loaded' })
        };
    }

    #injectFault(input: Parameters<BlackBoxRallarRuntime['injectFault']>[0]): void {
        this.#requireScriptedPorts('fault.inject');
        this.#foundation.rallar.diagnostics.faults.inject(decodeBlackBoxRallarFaultInput(input));
    }

    #readStorageCounters(input: Parameters<BlackBoxRallarRuntime['readStorageCounters']>[0]): IndexedDbOperationCounts {
        this.#requireScriptedPorts('storage.counters');
        const counters = decodeBlackBoxRallarStorageCountersInput(input);
        const storage = this.#foundation.rallar.diagnostics.storage;
        const counts = storage.getCounts();
        if (counters.reset) {
            storage.reset();
        }
        return counts;
    }

    #requireScriptedPorts(command: string): void {
        const config = this.#foundation.connectionState.get()?.config;
        if (config === undefined || toBlackBoxRallarDefaults(config) === undefined) {
            throw new TypeError(
                `${BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES.scriptedPortsUnavailable}: ` +
                    `${command} needs a connection that names an application.`
            );
        }
    }

    async #refreshRoom(options: BlackBoxRallarRoomRefreshOptions): Promise<void> {
        const config = requireConnectionConfig(this.#foundation.connectionState);
        const roomRef = blackBoxRallarRoomRefOf(config);
        const scope = blackBoxRallarScopeOf(config);
        if (!roomRef || !scope) {
            throwRallarValidation([{
                path: '$.roomRef',
                code: 'room-ref-required',
                message: 'Room refresh requires an exact room reference.'
            }]);
        }
        await this.#foundation.rallar.refreshRoomState(roomRef, { ...options, scope });
    }

    async #waitForRoom(options: BlackBoxRallarRoomWaitOptions): Promise<RallarRoomTransportStatus> {
        const config = requireConnectionConfig(this.#foundation.connectionState);
        const roomRef = blackBoxRallarRoomRefOf(config);
        if (!roomRef) {
            throwRallarValidation([{
                path: '$.roomRef',
                code: 'room-ref-required',
                message: 'Room RTC readiness requires an exact room reference.'
            }]);
        }
        return await this.#foundation.rallar.rtc.waitForRoom(roomRef, {
            connect: options.connect,
            laneId: resolveBlackBoxRallarLaneId(config),
            minReadyPeers: options.minReadyPeers,
            signal: options.signal,
            timeoutMs: options.timeoutMs
        });
    }
}

function createConnectionFoundation(
    input: BlackBoxRallarConnectionRuntime.Input
): BlackBoxRallarConnectionRuntime.Foundation {
    const rallar = input.facade;
    const diagnostics = new BlackBoxRallarRuntimeDiagnostics({
        now: input.clock.now,
        publish: (event) => input.targetWindow.__blackBoxRallarEmit?.(event),
        onPublishError: (error) => {
            console.error('black-box Rallar event sink failed', error);
        },
        transportOf: resolveBlackBoxRallarTransport,
        laneIdOf: resolveBlackBoxRallarLaneId,
        scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf
    });
    const lifecycle: BlackBoxRallarConnectionState.Lifecycle = createBlackBoxRallarLifecycleController({
        authenticationKey: toBlackBoxRallarAuthenticationKey,
        mergeAuthenticationConfig: mergeBlackBoxRallarAuthenticationConfig,
        authenticationClosedError: () => new Error('Authentication was cancelled because the Rallar runtime closed.'),
        connectionClosedError: () => new Error('Connection was cancelled because the Rallar runtime closed.')
    });
    const connectionState = new BlackBoxRallarConnectionState();
    return {
        rallar,
        diagnostics,
        diagnosticsPorts: createBlackBoxRallarDiagnosticsPorts(diagnostics, rallar.diagnostics),
        health: new BlackBoxRallarHealthReader({ rallar, diagnostics }),
        lifecycle,
        connectionState,
        authentication: new BlackBoxRallarAuthentication({
            rallar,
            runtimeDiagnostics: diagnostics,
            lifecycle,
            connectionState
        }),
        consoleDiagnostics: createBlackBoxRallarConsoleDiagnostics<BlackBoxRallarConnectionConfig>({
            console,
            activeConfig: () => connectionState.get()?.config,
            onWarning: diagnostics.emitConsoleWarning,
            restoreExisting: () => globalThis.__blackBoxRallarRestoreConsoleWarn?.(),
            publishRestore: (restore) => {
                globalThis.__blackBoxRallarRestoreConsoleWarn = restore;
            }
        })
    };
}

function createProductControllers(
    input: BlackBoxRallarConnectionRuntime.Input,
    foundation: BlackBoxRallarConnectionRuntime.Foundation
): BlackBoxRallarConnectionRuntime.Controllers {
    const { rallar, diagnostics, lifecycle, connectionState } = foundation;
    const generations = { generation: lifecycle.generation, isCurrent: lifecycle.isCurrent };
    return {
        crdt: new BlackBoxRallarCrdtController({
            ...generations,
            operationSignal: lifecycle.operationSignal,
            facade: rallar,
            now: input.clock.now,
            delay: input.delay,
            currentConnectionConfig: () => connectionState.get()?.config,
            ensureLiveConnection: new BlackBoxRallarCrdtLiveConnection(foundation).ensure,
            scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf,
            emit: diagnostics.emit,
            emitError: diagnostics.emitError
        }),
        director: new BlackBoxRallarDirectorController({
            ...generations,
            facade: rallar,
            now: input.clock.now,
            requireConfig: () => requireConnectionConfig(connectionState),
            transportOf: resolveBlackBoxRallarTransport,
            roomRefOf: blackBoxRallarRoomRefOf,
            scopeOf: blackBoxRallarScopeOf,
            scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf,
            emit: diagnostics.emit,
            emitError: diagnostics.emitError
        }),
        formation: new BlackBoxRallarFormationController({
            formation: (roomRef) => rallar.rooms.formation(roomRef),
            rtc: rallar.rtc,
            emit: diagnostics.emit,
            emitError: diagnostics.emitError,
            now: input.clock.now
        }),
        ...createMessagingControllers(foundation)
    };
}

function createMessagingControllers(
    foundation: BlackBoxRallarConnectionRuntime.Foundation
): Pick<
    BlackBoxRallarConnectionRuntime.Controllers,
    'messagingResources' | 'typedChannels' | 'messaging' | 'deliveryLedger'
> {
    const { rallar, diagnostics, lifecycle, connectionState } = foundation;
    const requireConfig = () => requireConnectionConfig(connectionState);
    const resources = createBlackBoxRallarMessagingResourceController({
        generation: lifecycle.generation,
        isCurrent: lifecycle.isCurrent
    });
    const typedChannels = new BlackBoxRallarTypedChannels({ messages: rallar.messages, resources, diagnostics });
    return {
        messagingResources: resources,
        typedChannels,
        messaging: new BlackBoxRallarMessagingController({
            messages: rallar.messages,
            realtime: rallar.realtime,
            resources,
            health: foundation.health,
            diagnostics,
            requireConfig
        }),
        deliveryLedger: new BlackBoxRallarDeliveryLedger({
            deliveries: rallar.deliveries,
            typedChannels,
            resources,
            diagnostics,
            requireConfig
        })
    };
}

function requireConnectionConfig(connectionState: BlackBoxRallarConnectionState): BlackBoxRallarConnectionConfig {
    const state = connectionState.get();
    if (!state) {
        throw new Error('Black-box Rallar runtime is not connected.');
    }
    return state.config;
}
