import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import type { RallarRoomTransportStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import { throwRallarValidation } from '@shared/api/rallar-validation.ts';
import type { IndexedDbOperationCounts } from '@shared/persistence/indexed-db-operation-observer.ts';
import type { ScriptedTransportFault } from '@shared/transport-faults/transport-fault-port.ts';

import { BlackBoxRallarCrdtController } from '../black-box-rallar-crdt-controller.ts';
import {
    BlackBoxRallarRuntimeDiagnostics,
    createBlackBoxRallarConsoleDiagnostics,
    createBlackBoxRallarDiagnosticsPorts,
    type BlackBoxRallarConsoleDiagnostics
} from '../black-box-rallar-diagnostics.ts';
import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarDocumentFacts,
    BlackBoxRallarHealthDiagnostics,
    BlackBoxRallarHealthInput,
    BlackBoxRallarStorageCountersInput
} from '../black-box-rallar-operation-contracts.ts';
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
import { decodeBlackBoxCommandNumber, requireBlackBoxRallarInput } from '../decode-black-box-rallar-command-input.ts';
import { BlackBoxRallarDirectorController } from '../director-controller.ts';
import { BlackBoxRallarFormationController } from '../formation/formation-controller.ts';
import { createBlackBoxRallarLifecycleController } from '../lifecycle-controller.ts';
import { BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES } from '../messaging/black-box-rallar-delivery-error-message-prefixes.ts';
import { BlackBoxRallarDeliveryLedger } from '../messaging/black-box-rallar-delivery-ledger.ts';
import { BlackBoxRallarRtcSendController } from '../messaging/black-box-rallar-rtc-send-controller.ts';
import { BlackBoxRallarTypedChannels } from '../messaging/black-box-rallar-typed-channels.ts';
import { BlackBoxRallarWsSendController } from '../messaging/black-box-rallar-ws-send-controller.ts';
import {
    createBlackBoxRallarMessagingResourceController,
    type BlackBoxRallarMessagingResourceController
} from '../messaging/create-black-box-rallar-messaging-resource-controller.ts';
import { decodeBlackBoxRallarMessageSendInput } from '../messaging/decode-black-box-rallar-message-send-input.ts';
import {
    decodeBlackBoxRallarDeliveryHandleInput,
    decodeBlackBoxRallarDeliveryObserveInput,
    decodeBlackBoxRallarFaultInput,
    decodeBlackBoxRallarStorageCountersInput
} from '../messaging/decode-black-box-rallar-messaging-input.ts';
import {
    decodeBlackBoxRallarSendCommand,
    decodeBlackBoxRallarWsSendInput
} from '../messaging/decode-black-box-rallar-send-input.ts';
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
import { BlackBoxRallarConnectionSubscriptions } from './black-box-rallar-connection-subscriptions.ts';
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
        readonly readDocument: () => BlackBoxRallarDocumentFacts;
    }

    export type MessagingMethod =
        | 'send'
        | 'sendWs'
        | 'sendMessage'
        | 'observeDelivery'
        | 'cancelDelivery'
        | 'readReceipts'
        | 'injectFault'
        | 'readStorageCounters';

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
        readonly subscriptions: BlackBoxRallarConnectionSubscriptions;
        readonly typedChannels: BlackBoxRallarTypedChannels;
        readonly rtcSend: BlackBoxRallarRtcSendController;
        readonly wsSend: BlackBoxRallarWsSendController;
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
        const { crdt, director, formation, typedChannels, subscriptions } = this.#controllers;
        this.#connectOperation = new BlackBoxRallarConnectOperation({
            ...this.#foundation,
            formation,
            typedChannels,
            subscriptions
        });
        this.#closeOperation = new BlackBoxRallarCloseOperation({
            ...this.#foundation,
            crdt,
            director,
            subscriptions
        });
    }

    installation(): BlackBoxRallarConnectionRuntime.Installation {
        const { authentication, diagnostics, rallar } = this.#foundation;
        const { crdt, director, formation } = this.#controllers;
        const runtime: BlackBoxRallarRuntime = {
            authenticate: authentication.authenticate,
            connect: this.#connectOperation.connect,
            ...this.#messagingSurface(),
            refreshRoom: async (options) => await this.#refreshRoom(options),
            waitForRoom: async (options) => await this.#waitForRoom(options),
            readRtcMessageNacks: (messageId) => rallar.readRtcMessageNacks(messageId),
            crdt,
            director,
            formation,
            close: this.#closeOperation.close,
            health: async (input = {}) => await this.#readHealth(input)
        };
        return {
            runtime,
            emitRuntimeLoaded: () => diagnostics.emit({ kind: 'diagnostic', topic: 'rallar.browser.runtime_loaded' })
        };
    }

    /** The window surface is the page boundary: each command input is decoded here before any owner sees it. */
    #messagingSurface(): Pick<BlackBoxRallarRuntime, BlackBoxRallarConnectionRuntime.MessagingMethod> {
        const { rtcSend, wsSend, deliveryLedger } = this.#controllers;
        return {
            send: async (input, deadlineEpochMs) =>
                await rtcSend.send(
                    requireBlackBoxRallarInput(decodeBlackBoxRallarSendCommand(input)),
                    decodeBlackBoxCommandNumber(deadlineEpochMs)
                ),
            sendWs: async (input) =>
                await wsSend.sendWs(requireBlackBoxRallarInput(decodeBlackBoxRallarWsSendInput(input))),
            sendMessage: async (input) =>
                await deliveryLedger.sendMessage(
                    requireBlackBoxRallarInput(decodeBlackBoxRallarMessageSendInput(input))
                ),
            observeDelivery: async (input) =>
                await deliveryLedger.observeDelivery(
                    requireBlackBoxRallarInput(decodeBlackBoxRallarDeliveryObserveInput(input))
                ),
            cancelDelivery: async (input) =>
                await deliveryLedger.cancelDelivery(
                    requireBlackBoxRallarInput(decodeBlackBoxRallarDeliveryHandleInput(input))
                ),
            readReceipts: async (input) =>
                await deliveryLedger.readReceipts(
                    requireBlackBoxRallarInput(decodeBlackBoxRallarDeliveryHandleInput(input))
                ),
            injectFault: async (input) =>
                this.#injectFault(requireBlackBoxRallarInput(decodeBlackBoxRallarFaultInput(input))),
            readStorageCounters: async (input) =>
                this.#readStorageCounters(requireBlackBoxRallarInput(decodeBlackBoxRallarStorageCountersInput(input)))
        };
    }

    async #readHealth(input: BlackBoxRallarHealthInput): Promise<BlackBoxRallarHealthDiagnostics> {
        const { crdt, director, formation } = this.#controllers;
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

    #injectFault(fault: ScriptedTransportFault): void {
        this.#requireScriptedPorts('fault.inject');
        this.#foundation.rallar.diagnostics.faults.inject(fault);
    }

    #readStorageCounters(counters: BlackBoxRallarStorageCountersInput): IndexedDbOperationCounts {
        this.#requireScriptedPorts('storage.counters');
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
        health: new BlackBoxRallarHealthReader({ rallar, diagnostics, readDocument: input.readDocument }),
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
        ...createMessagingControllers(foundation, input.clock)
    };
}

function createMessagingControllers(
    foundation: BlackBoxRallarConnectionRuntime.Foundation,
    clock: BlackBoxRallarConnectionRuntime.Input['clock']
): Pick<
    BlackBoxRallarConnectionRuntime.Controllers,
    'messagingResources' | 'subscriptions' | 'typedChannels' | 'rtcSend' | 'wsSend' | 'deliveryLedger'
> {
    const { rallar, diagnostics, lifecycle, connectionState } = foundation;
    const requireConfig = () => requireConnectionConfig(connectionState);
    const resources = createBlackBoxRallarMessagingResourceController({
        generation: lifecycle.generation,
        isCurrent: lifecycle.isCurrent
    });
    const typedChannels = new BlackBoxRallarTypedChannels({ messages: rallar.messages, resources, diagnostics });
    const health = foundation.health;
    return {
        messagingResources: resources,
        subscriptions: new BlackBoxRallarConnectionSubscriptions({
            rallar,
            diagnostics,
            messagingResources: resources
        }),
        typedChannels,
        rtcSend: new BlackBoxRallarRtcSendController({
            now: clock.now,
            operationSignal: lifecycle.operationSignal,
            messages: rallar.messages,
            realtime: rallar.realtime,
            resources,
            health,
            diagnostics,
            requireConfig
        }),
        wsSend: new BlackBoxRallarWsSendController({
            messages: rallar.messages,
            resources,
            health,
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
