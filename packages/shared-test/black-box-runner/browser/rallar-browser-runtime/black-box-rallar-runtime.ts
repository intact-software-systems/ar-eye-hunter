import type { AuthSession, LoginResponse } from '@shared/api/api-config.ts';
import { throwRallarValidation } from '@shared/api/rallar-validation.ts';
import type { RallarCrdtTransportStrategy } from '@shared/crdt/mod.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { BlackBoxRallarAuthentication } from './black-box-rallar-authentication.ts';
import {
    DEFAULT_LANE_ID,
    resolveBlackBoxRallarLaneId,
    resolveBlackBoxRallarMessageSelector,
    resolveBlackBoxRallarTopicId,
    resolveBlackBoxRallarTransport,
    resolveBlackBoxRallarTypeId,
    toBlackBoxRallarAuthenticationKey,
    toBlackBoxRallarDefaults,
    toBlackBoxRallarSessionDiagnostic
} from './black-box-rallar-connection-policy.ts';
import { BlackBoxRallarConnectionState } from './black-box-rallar-connection-state.ts';
import { BlackBoxRallarCrdtController } from './black-box-rallar-crdt-controller.ts';
import {
    BlackBoxRallarRuntimeDiagnostics,
    createBlackBoxRallarConsoleDiagnostics
} from './black-box-rallar-diagnostics.ts';
import { BlackBoxRallarHealthReader } from './black-box-rallar-health-reader.ts';
import type {
    BlackBoxRallarCloseDiagnostics,
    BlackBoxRallarConnectDiagnostics,
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarEvent
} from './black-box-rallar-operation-contracts.ts';
import {
    blackBoxRallarConnectionOperationKeyOf,
    blackBoxRallarConnectionTargetOf,
    blackBoxRallarRoomRefOf,
    blackBoxRallarScopeDiagnosticsOf,
    blackBoxRallarScopeOf,
    decideBlackBoxRallarLifecycleRequest,
    mergeBlackBoxRallarAuthenticationConfig
} from './black-box-rallar-operation-policy.ts';
import type { BlackBoxRallarRoomRefreshOptions, BlackBoxRallarRuntime } from './black-box-rallar-runtime-contract.ts';
import {
    toBlackBoxRallarSerializedError,
    type BlackBoxRallarSerializedError
} from './black-box-rallar-serialized-error.ts';
import {
    createBlackBoxBrowserRallarRuntimeDependency,
    type BlackBoxBrowserRallarRuntimeDependency
} from './browser-rallar-runtime-composition.ts';
import { BlackBoxRallarDirectorController } from './director-controller.ts';
import { BlackBoxRallarFormationController } from './formation/formation-controller.ts';
import {
    createBlackBoxRallarLifecycleController,
    type BlackBoxRallarLifecycleOperationContext
} from './lifecycle-controller.ts';
import { BlackBoxRallarMessagingController } from './messaging-controller.ts';

export type {
    BlackBoxRallarAuthenticateDiagnostics,
    BlackBoxRallarCloseDiagnostics,
    BlackBoxRallarConfig,
    BlackBoxRallarConnectDiagnostics,
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarCrdtApplyInput,
    BlackBoxRallarCrdtCommandDiagnostics,
    BlackBoxRallarCrdtHandleInput,
    BlackBoxRallarCrdtOpenInput,
    BlackBoxRallarCrdtRuntime,
    BlackBoxRallarCrdtRuntimeSummary,
    BlackBoxRallarCrdtSyncInput,
    BlackBoxRallarCrdtUndoRedoInput,
    BlackBoxRallarCrdtWaitCondition,
    BlackBoxRallarCrdtWaitInput,
    BlackBoxRallarCrdtWaitOperator,
    BlackBoxRallarDirectorAppointInput,
    BlackBoxRallarDirectorCommandDiagnostics,
    BlackBoxRallarDirectorHandleInput,
    BlackBoxRallarDirectorIntentInput,
    BlackBoxRallarDirectorOutputRecord,
    BlackBoxRallarDirectorRelayStartInput,
    BlackBoxRallarDirectorRelaySummary,
    BlackBoxRallarDirectorRoomInput,
    BlackBoxRallarDirectorRuntime,
    BlackBoxRallarDirectorStatusInput,
    BlackBoxRallarDirectorSyncRequestInput,
    BlackBoxRallarEvent,
    BlackBoxRallarHealthDiagnostics,
    BlackBoxRallarHealthInput,
    BlackBoxRallarSendDiagnostics,
    BlackBoxRallarSendInput,
    BlackBoxRallarTransport,
    BlackBoxRallarWsSendDiagnostics
} from './black-box-rallar-operation-contracts.ts';

export type {
    BlackBoxRallarRoomRefreshOptions,
    BlackBoxRallarRuntime
} from './black-box-rallar-runtime-contract.ts';

interface RuntimeConnectionAttempt {
    readonly config: BlackBoxRallarConnectionConfig;
    readonly context: BlackBoxRallarLifecycleOperationContext;
    phase: string;
    lifecycleSubscriptions?: Pick<
        BlackBoxRallarConnectionState.Value,
        'unsubscribeWsLifecycle' | 'unsubscribeRtcLifecycle' | 'unsubscribeFormationDiagnostics'
    >;
    unsubscribeConsoleDiagnostics?: () => void;
}

interface RuntimeProductControllers {
    readonly crdt: BlackBoxRallarCrdtController;
    readonly director: BlackBoxRallarDirectorController;
    readonly formation: BlackBoxRallarFormationController;
    readonly messaging: BlackBoxRallarMessagingController;
}
interface RuntimeTransportCloseResult {
    readonly logout: boolean;
    readonly disconnected: boolean;
}

interface RuntimeClosePreparation {
    runtimeState?: BlackBoxRallarConnectionState.Value;
    config?: BlackBoxRallarConnectionConfig;
}

export interface BlackBoxRallarRuntimeInstallationTarget {
    __blackBoxRallar?: BlackBoxRallarRuntime;
    __blackBoxRallarEmit?: (event: BlackBoxRallarEvent) => void | Promise<void>;
}

declare global {
    interface Window extends BlackBoxRallarRuntimeInstallationTarget {}
    var __blackBoxRallarRestoreConsoleWarn: (() => void) | undefined;
}

interface BlackBoxRallarRuntimeInstallation {
    runtime: BlackBoxRallarRuntime;
    emitRuntimeLoaded(): void;
}

namespace BlackBoxRallarConnectionRuntime {
    export interface Input {
        facade: BlackBoxBrowserRallarRuntimeDependency;
        targetWindow: BlackBoxRallarRuntimeInstallationTarget;
        clock: {
            now(): number;
        };
        delay: (ms: number) => Promise<void>;
    }
}

class BlackBoxRallarConnectionRuntime {
    readonly #healthReader;
    readonly #connectionState = new BlackBoxRallarConnectionState();
    readonly #authentication;
    readonly #rallar;
    readonly #targetWindow;
    readonly #now;
    readonly #wait;
    #closeRetryConfig: BlackBoxRallarConnectionConfig | undefined;
    readonly #runtimeDiagnostics;
    readonly #lifecycle;
    readonly #crdtController;
    readonly #directorController;
    readonly #formationController;
    readonly #messagingController;
    readonly #consoleDiagnostics;
    constructor(options: BlackBoxRallarConnectionRuntime.Input) {
        this.#rallar = options.facade;
        this.#targetWindow = options.targetWindow;
        this.#now = options.clock.now;
        this.#wait = options.delay;
        this.#runtimeDiagnostics = new BlackBoxRallarRuntimeDiagnostics({
            now: this.#now,
            publish: (event) => this.#targetWindow.__blackBoxRallarEmit?.(event),
            onPublishError: (error) => {
                console.error('black-box Rallar event sink failed', error);
            },
            transportOf: resolveBlackBoxRallarTransport,
            laneIdOf: resolveBlackBoxRallarLaneId,
            scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf
        });
        this.#lifecycle = createBlackBoxRallarLifecycleController<
            BlackBoxRallarConnectionConfig,
            LoginResponse | AuthSession,
            BlackBoxRallarConnectDiagnostics,
            BlackBoxRallarCloseDiagnostics
        >({
            authenticationKey: toBlackBoxRallarAuthenticationKey,
            mergeAuthenticationConfig: mergeBlackBoxRallarAuthenticationConfig,
            authenticationClosedError: () =>
                new Error('Authentication was cancelled because the Rallar runtime closed.'),
            connectionClosedError: () => new Error('Connection was cancelled because the Rallar runtime closed.')
        });
        this.#healthReader = new BlackBoxRallarHealthReader({
            rallar: this.#rallar,
            diagnostics: this.#runtimeDiagnostics
        });
        this.#authentication = new BlackBoxRallarAuthentication({
            rallar: this.#rallar,
            runtimeDiagnostics: this.#runtimeDiagnostics,
            lifecycle: this.#lifecycle,
            connectionState: this.#connectionState
        });
        const controllers = this.#createProductControllers();
        this.#crdtController = controllers.crdt;
        this.#directorController = controllers.director;
        this.#formationController = controllers.formation;
        this.#messagingController = controllers.messaging;
        this.#consoleDiagnostics = createBlackBoxRallarConsoleDiagnostics<BlackBoxRallarConnectionConfig>({
            console,
            activeConfig: () => this.#connectionState.get()?.config,
            onWarning: this.#runtimeDiagnostics.emitConsoleWarning,
            restoreExisting: () => globalThis.__blackBoxRallarRestoreConsoleWarn?.(),
            publishRestore: (restore) => {
                globalThis.__blackBoxRallarRestoreConsoleWarn = restore;
            }
        });
    }

    #createProductControllers(): RuntimeProductControllers {
        const crdt = new BlackBoxRallarCrdtController({
            generation: this.#lifecycle.generation,
            operationSignal: this.#lifecycle.operationSignal,
            isCurrent: this.#lifecycle.isCurrent,
            facade: this.#rallar,
            now: this.#now,
            delay: this.#wait,
            currentConnectionConfig: () => this.#connectionState.get()?.config,
            ensureLiveConnection: this.#ensureCrdtLiveConnection,
            scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf,
            emit: this.#runtimeDiagnostics.emit,
            emitError: this.#runtimeDiagnostics.emitError
        });
        const director = new BlackBoxRallarDirectorController({
            generation: this.#lifecycle.generation,
            isCurrent: this.#lifecycle.isCurrent,
            facade: this.#rallar,
            now: this.#now,
            requireConfig: () => this.#requireState().config,
            transportOf: resolveBlackBoxRallarTransport,
            roomRefOf: blackBoxRallarRoomRefOf,
            scopeOf: blackBoxRallarScopeOf,
            scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf,
            emit: this.#runtimeDiagnostics.emit,
            emitError: this.#runtimeDiagnostics.emitError
        });
        const messaging = new BlackBoxRallarMessagingController({
            generation: this.#lifecycle.generation,
            isCurrent: this.#lifecycle.isCurrent,
            facade: this.#rallar,
            requireConfig: () => this.#requireState().config,
            transportOf: resolveBlackBoxRallarTransport,
            laneIdOf: resolveBlackBoxRallarLaneId,
            typeIdOf: resolveBlackBoxRallarTypeId,
            topicIdOf: resolveBlackBoxRallarTopicId,
            roomRefOf: blackBoxRallarRoomRefOf,
            scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf,
            readHealth: this.#healthReader.readHealth,
            wsStatus: this.#healthReader.wsStatusFor,
            rtcStatus: this.#healthReader.rtcStatusFor,
            emit: this.#runtimeDiagnostics.emit,
            emitDiagnostic: this.#runtimeDiagnostics.emitDiagnostic,
            emitError: this.#runtimeDiagnostics.emitError
        });
        const formation = new BlackBoxRallarFormationController({
            formation: (roomRef) => this.#rallar.rooms.formation(roomRef),
            rtc: this.#rallar.rtc,
            emit: this.#runtimeDiagnostics.emit,
            emitError: this.#runtimeDiagnostics.emitError,
            now: this.#now
        });
        return { crdt, director, formation, messaging };
    }
    #configureRallarConnection = (
        config: BlackBoxRallarConnectionConfig
    ): Parameters<BlackBoxBrowserRallarRuntimeDependency['setDefaults']>[0] => {
        this.#rallar.configure({ apiBaseUrl: config.rallar.apiBaseUrl });
        const defaults = toBlackBoxRallarDefaults(config);
        this.#rallar.setDefaults(defaults);
        return defaults;
    };
    #cleanupRuntimeSubscriptions = (
        runtimeState: BlackBoxRallarConnectionState.Value | undefined,
        topicConfig: BlackBoxRallarConnectionConfig | undefined
    ): number => {
        let unsubscribed = 0;
        if (runtimeState?.unsubscribeMessagesRtc) {
            runtimeState.unsubscribeMessagesRtc();
            unsubscribed += 1;
        }
        if (runtimeState?.unsubscribeRealtime) {
            runtimeState.unsubscribeRealtime();
            unsubscribed += 1;
        }
        if (runtimeState?.unsubscribeRtcLifecycle) {
            runtimeState.unsubscribeRtcLifecycle();
            unsubscribed += 1;
        }
        if (runtimeState?.unsubscribeFormationDiagnostics) {
            runtimeState.unsubscribeFormationDiagnostics();
            unsubscribed += 1;
        }
        if (runtimeState?.unsubscribeWsLifecycle) {
            runtimeState.unsubscribeWsLifecycle();
            unsubscribed += 1;
        }
        if (runtimeState?.unsubscribeConsoleDiagnostics) {
            runtimeState.unsubscribeConsoleDiagnostics();
        }
        unsubscribed += this.#messagingController.cleanupWsSubscriptions();
        if (unsubscribed > 0 && topicConfig) {
            this.#runtimeDiagnostics.emitDiagnostic(topicConfig, 'rallar.browser.cleanup.unsubscribe_completed', {
                unsubscribed
            });
        }
        return unsubscribed;
    };
    #emitSessionDiagnostics = (
        config: BlackBoxRallarConnectionConfig,
        session: BlackBoxRallarConnectionState.Session,
        previousState: BlackBoxRallarConnectionState.Value | undefined
    ): void => {
        const expectedSessionId = config.rallar.expectedSessionId;
        if (expectedSessionId && expectedSessionId !== session.sessionId) {
            this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.session.expected_mismatch', {
                expectedSessionId,
                actualSessionId: session.sessionId,
                username: session.username
            });
        }

        if (!previousState) {
            return;
        }

        if (previousState.session.sessionId === session.sessionId) {
            this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.session.duplicate_detected', {
                session: toBlackBoxRallarSessionDiagnostic(session),
                previousConnection: previousState.config.connection,
                previousRoomId: previousState.config.roomId
            });
            return;
        }

        this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.session.active_replaced', {
            previousSession: toBlackBoxRallarSessionDiagnostic(previousState.session),
            nextSession: toBlackBoxRallarSessionDiagnostic(session),
            previousConnection: previousState.config.connection,
            previousRoomId: previousState.config.roomId
        });
    };
    #requireState = (): BlackBoxRallarConnectionState.Value => {
        const state = this.#connectionState.get();
        if (!state) {
            throw new Error('Black-box Rallar runtime is not connected.');
        }
        return state;
    };
    #installRallarLifecycleDiagnostics = (
        config: BlackBoxRallarConnectionConfig
    ): Pick<
        BlackBoxRallarConnectionState.Value,
        'unsubscribeWsLifecycle' | 'unsubscribeRtcLifecycle' | 'unsubscribeFormationDiagnostics'
    > => {
        const { ws, rtc } = this.#rallar;
        // The formation stream is room-scoped, so a connection that names no room installs none.
        const roomRef = blackBoxRallarRoomRefOf(config);

        return {
            ...(roomRef
                ? { unsubscribeFormationDiagnostics: this.#formationController.installDiagnostics(roomRef) }
                : {}),
            unsubscribeWsLifecycle: ws.onLifecycle(
                (event) => this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.ws.lifecycle', event),
                { emitCurrent: true }
            ),
            unsubscribeRtcLifecycle: rtc.onLifecycle(
                (event) => this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.rtc.lifecycle', event),
                { emitCurrent: true }
            )
        };
    };
    #prepareConnection = (attempt: RuntimeConnectionAttempt): void => {
        const { config } = attempt;
        const transport = resolveBlackBoxRallarTransport(config);

        attempt.phase = 'transport-config';
        this.#runtimeDiagnostics.emitConnectPhaseStarted(config, attempt.phase, { transport });
        const laneId = transport === 'realtime' ? resolveBlackBoxRallarLaneId(config) : undefined;
        const typeId = transport === 'messages.rtc' ? resolveBlackBoxRallarTypeId(config) : undefined;
        const topicId = transport === 'messages.rtc' ? resolveBlackBoxRallarTopicId(config) : undefined;
        this.#runtimeDiagnostics.emitConnectPhaseCompleted(config, attempt.phase, {
            transport,
            laneId,
            typeId,
            topicId
        });

        attempt.phase = 'configure';
        this.#runtimeDiagnostics.emitConnectPhaseStarted(config, attempt.phase, {
            apiBaseUrl: config.rallar.apiBaseUrl,
            ...blackBoxRallarScopeDiagnosticsOf(config)
        });
        this.#authentication.requireCredentialsForAuthenticationIdentityChange(config);
        const defaults = this.#configureRallarConnection(config);
        this.#runtimeDiagnostics.emitConnectPhaseCompleted(config, attempt.phase, {
            defaults
        });
    };
    #openConnection = async (attempt: RuntimeConnectionAttempt): Promise<void> => {
        const { config, context } = attempt;
        attempt.phase = 'rallar-connect';
        this.#runtimeDiagnostics.emitConnectPhaseStarted(config, attempt.phase, {
            timeoutMs: config.rallar.timeoutMs,
            dataChannelLanes: config.rallar.dataChannelLanes,
            ...this.#healthReader.statusDiagnostics(config)
        });
        await this.#rallar.connect({
            timeoutMs: config.rallar.timeoutMs,
            dataChannelLanes: config.rallar.dataChannelLanes
        });
        context.assertCurrent();
        this.#runtimeDiagnostics.emitConnectPhaseCompleted(config, attempt.phase, {
            ...this.#healthReader.statusDiagnostics(config)
        });

        if (config.roomId) {
            const roomRef = blackBoxRallarRoomRefOf(config);
            const scope = blackBoxRallarScopeOf(config);
            attempt.phase = 'room-join';
            this.#runtimeDiagnostics.emitConnectPhaseStarted(config, attempt.phase, {
                roomId: config.roomId,
                roomRef,
                scope
            });
            await this.#rallar.rooms.join(config.roomId, {
                timeoutMs: config.rallar.timeoutMs,
                scope
            });
            context.assertCurrent();
            this.#runtimeDiagnostics.emitConnectPhaseCompleted(config, attempt.phase, {
                roomId: config.roomId,
                roomRef,
                scope,
                ...this.#healthReader.statusDiagnostics(config)
            });
        }
    };
    #subscribeRealtime = (
        config: BlackBoxRallarConnectionConfig,
        session: BlackBoxRallarConnectionState.Session
    ): (() => void) | undefined => {
        const transport = resolveBlackBoxRallarTransport(config);
        const laneId = resolveBlackBoxRallarLaneId(config);
        return transport === 'realtime'
            ? this.#rallar.realtime.onJson(laneId ?? DEFAULT_LANE_ID, (message) => {
                this.#runtimeDiagnostics.emit({
                    kind: 'message',
                    topic: 'rallar.browser.realtime.message',
                    connection: config.connection,
                    actor: config.actor,
                    transport,
                    roomId: config.roomId,
                    ...blackBoxRallarScopeDiagnosticsOf(config),
                    laneId: message.laneId,
                    peerId: session.sessionId,
                    remotePeerId: message.peerId,
                    data: message.data
                });
            })
            : undefined;
    };
    #subscribeMessages = (
        config: BlackBoxRallarConnectionConfig,
        session: BlackBoxRallarConnectionState.Session
    ): (() => void) | undefined => {
        const transport = resolveBlackBoxRallarTransport(config);
        return transport === 'messages.rtc'
            ? this.#rallar.messages.rtc.onMessage(resolveBlackBoxRallarMessageSelector(config), (message) => {
                this.#runtimeDiagnostics.emit({
                    kind: 'message',
                    topic: 'rallar.browser.messages.rtc.message',
                    connection: config.connection,
                    actor: config.actor,
                    transport,
                    roomId: message.roomId ?? config.roomId,
                    ...blackBoxRallarScopeDiagnosticsOf(config),
                    peerId: session.sessionId,
                    remotePeerId: message.senderId,
                    senderId: message.senderId,
                    typeId: message.typeId,
                    topicId: message.topicId,
                    contextId: message.contextId,
                    resourceId: message.resourceId,
                    data: message.payload
                });
            })
            : undefined;
    };
    #subscribeConnection = (
        attempt: RuntimeConnectionAttempt,
        session: BlackBoxRallarConnectionState.Session
    ): BlackBoxRallarConnectionState.Value => {
        const { config } = attempt;
        const transport = resolveBlackBoxRallarTransport(config);
        const laneId = transport === 'realtime' ? resolveBlackBoxRallarLaneId(config) : undefined;
        const typeId = transport === 'messages.rtc' ? resolveBlackBoxRallarTypeId(config) : undefined;
        const topicId = transport === 'messages.rtc' ? resolveBlackBoxRallarTopicId(config) : undefined;
        attempt.phase = transport === 'realtime' ? 'subscribe-realtime' : 'subscribe-messages.rtc';
        this.#runtimeDiagnostics.emitConnectPhaseStarted(config, attempt.phase, {
            laneId,
            typeId,
            topicId,
            selector: transport === 'messages.rtc' ? resolveBlackBoxRallarMessageSelector(config) : undefined
        });
        const unsubscribeRealtime = this.#subscribeRealtime(config, session);
        const unsubscribeMessagesRtc = this.#subscribeMessages(config, session);
        this.#runtimeDiagnostics.emitConnectPhaseCompleted(config, attempt.phase, {
            laneId,
            typeId,
            topicId,
            ...this.#healthReader.statusDiagnostics(config)
        });

        return {
            config,
            session,
            unsubscribeRealtime,
            unsubscribeMessagesRtc,
            unsubscribeConsoleDiagnostics: attempt.unsubscribeConsoleDiagnostics,
            ...attempt.lifecycleSubscriptions
        };
    };
    #connectionDiagnostics = (state: BlackBoxRallarConnectionState.Value): BlackBoxRallarConnectDiagnostics => {
        const { config, session } = state;
        const transport = resolveBlackBoxRallarTransport(config);
        const laneId = transport === 'realtime' ? resolveBlackBoxRallarLaneId(config) : undefined;
        const typeId = transport === 'messages.rtc' ? resolveBlackBoxRallarTypeId(config) : undefined;
        const topicId = transport === 'messages.rtc' ? resolveBlackBoxRallarTopicId(config) : undefined;
        return {
            status: 'connected',
            connection: config.connection,
            actor: config.actor,
            transport,
            roomId: config.roomId,
            ...blackBoxRallarScopeDiagnosticsOf(config),
            clientId: session.clientId,
            sessionId: session.sessionId,
            username: session.username,
            laneId,
            typeId,
            topicId,
            wsStatus: this.#healthReader.wsStatusFor(),
            rtcStatus: this.#healthReader.rtcStatusFor(config),
            health: this.#healthReader.readHealth(config)
        };
    };
    #connectEffect = async (
        config: BlackBoxRallarConnectionConfig,
        context: BlackBoxRallarLifecycleOperationContext
    ): Promise<BlackBoxRallarConnectDiagnostics> => {
        const attempt: RuntimeConnectionAttempt = { config, context, phase: 'validate-config' };
        try {
            if (!config.rallar.apiBaseUrl) {
                throw new Error('rallar.apiBaseUrl is required.');
            }
            this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.connect_started');
            attempt.unsubscribeConsoleDiagnostics = this.#consoleDiagnostics.install(config);
            this.#prepareConnection(attempt);
            attempt.phase = 'auth';
            const session = this.#connectionState.get()?.session ??
                await this.#authentication.sessionForAuthentication(config);
            context.assertCurrent();
            this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.authenticated', {
                clientId: session.clientId,
                sessionId: session.sessionId,
                username: session.username
            });
            const previousState = this.#connectionState.get();
            this.#emitSessionDiagnostics(config, session, previousState);
            attempt.lifecycleSubscriptions = this.#installRallarLifecycleDiagnostics(config);
            await this.#openConnection(attempt);
            const state = this.#subscribeConnection(attempt, session);
            this.#cleanupRuntimeSubscriptions(previousState, config);
            this.#connectionState.set(state);
            const diagnostics = this.#connectionDiagnostics(state);
            this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.connect_completed', diagnostics);
            return diagnostics;
        }
        catch (caught) {
            const error = toError(caught);
            attempt.lifecycleSubscriptions?.unsubscribeRtcLifecycle?.();
            attempt.lifecycleSubscriptions?.unsubscribeWsLifecycle?.();
            attempt.unsubscribeConsoleDiagnostics?.();
            this.#runtimeDiagnostics.emitError({
                config: config,
                topic: 'rallar.browser.connect.phase_failed',
                error: error,
                data: {
                    phase: attempt.phase
                }
            });
            this.#runtimeDiagnostics.emitError({
                config: config,
                topic: 'rallar.browser.connect_failed',
                error: error,
                data: {
                    phase: attempt.phase
                }
            });
            throw error;
        }
    };
    #connectedTargetRejection = (config: BlackBoxRallarConnectionConfig): Error | undefined => {
        const state = this.#connectionState.get();
        if (!state) {
            return undefined;
        }
        const decision = decideBlackBoxRallarLifecycleRequest(
            {
                status: 'connected',
                activeTarget: blackBoxRallarConnectionTargetOf(
                    state.config,
                    state.session
                )
            },
            {
                kind: 'connect',
                target: blackBoxRallarConnectionTargetOf(config, state.session)
            }
        );
        return decision.kind === 'reject'
            ? new Error(decision.reason)
            : undefined;
    };
    #ensureCrdtLiveConnection = async (
        config: BlackBoxRallarConnectionConfig,
        transportStrategy: RallarCrdtTransportStrategy
    ): Promise<void> => {
        if (this.#lifecycle.authenticationConfig()) {
            await this.#lifecycle.waitForAuthentication();
            return await this.#ensureCrdtLiveConnection(config, transportStrategy);
        }
        const rejection = this.#connectedTargetRejection(config);
        if (rejection) {
            throw rejection;
        }
        await this.#lifecycle.runExclusive(
            'crdt-live:' + blackBoxRallarConnectionOperationKeyOf(config),
            async (context) => {
                const queuedRejection = this.#connectedTargetRejection(config);
                if (queuedRejection) {
                    throw queuedRejection;
                }
                this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.crdt.configure_started', {
                    transportStrategy
                });
                const defaults = this.#configureRallarConnection(config);
                this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.crdt.configure_completed', {
                    defaults
                });

                if (!this.#rallar.isConnected()) {
                    const session = await this.#authentication.sessionForAuthentication(config);
                    context.assertCurrent();
                    await this.#rallar.connect({
                        timeoutMs: config.rallar.timeoutMs
                    });
                    context.assertCurrent();
                    if (config.roomId) {
                        await this.#rallar.rooms.join(config.roomId, {
                            timeoutMs: config.rallar.timeoutMs,
                            scope: blackBoxRallarScopeOf(config)
                        });
                        context.assertCurrent();
                    }
                    this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.crdt.connected', {
                        session: toBlackBoxRallarSessionDiagnostic(session),
                        transportStrategy
                    });
                }
            }
        );
    };
    #connect = (config: BlackBoxRallarConnectionConfig): Promise<BlackBoxRallarConnectDiagnostics> => {
        const key = blackBoxRallarConnectionOperationKeyOf(config);
        const activeAuthentication = this.#lifecycle.authenticationConfig();
        if (
            activeAuthentication &&
            toBlackBoxRallarAuthenticationKey(activeAuthentication) !== toBlackBoxRallarAuthenticationKey(config)
        ) {
            return this.#lifecycle.waitForAuthentication().then(
                () => this.#connect(config),
                () => this.#connect(config)
            );
        }

        const immediateRejection = this.#connectedTargetRejection(config);
        if (immediateRejection) {
            return Promise.reject(immediateRejection);
        }

        return this.#lifecycle.runConnect(key, (context) => {
            const queuedRejection = this.#connectedTargetRejection(config);
            if (queuedRejection) {
                return Promise.reject(queuedRejection);
            }
            return this.#connectEffect(config, context);
        });
    };
    #closeResources = async (
        preparation: RuntimeClosePreparation,
        cleanupErrors: BlackBoxRallarSerializedError[]
    ): Promise<number> => {
        const { runtimeState, config } = preparation;
        let unsubscribed = 0;
        try {
            unsubscribed = this.#cleanupRuntimeSubscriptions(runtimeState, config);
        }
        catch (caught) {
            const error = toError(caught);
            cleanupErrors.push(toBlackBoxRallarSerializedError(error));
            this.#runtimeDiagnostics.emitError({
                config: config,
                topic: 'rallar.browser.cleanup.unsubscribe_failed',
                error: error
            });
        }

        for (const error of this.#directorController.closeAll(config)) {
            cleanupErrors.push(toBlackBoxRallarSerializedError(error));
        }

        for (const error of await this.#crdtController.closeAll(config)) {
            cleanupErrors.push(toBlackBoxRallarSerializedError(error));
        }

        return unsubscribed;
    };
    #leaveRoomForClose = async (
        config: BlackBoxRallarConnectionConfig | undefined,
        cleanupErrors: BlackBoxRallarSerializedError[]
    ): Promise<boolean> => {
        if (config?.roomId && config.rallar.leaveRoomOnClose !== false) {
            const roomRef = blackBoxRallarRoomRefOf(config);
            const scope = blackBoxRallarScopeOf(config);
            this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.room_leave_started', {
                roomId: config.roomId,
                roomRef,
                scope
            });
            try {
                await this.#rallar.rooms.leave({
                    roomId: config.roomId,
                    roomRef,
                    scope,
                    clearCurrent: true,
                    timeoutMs: config.rallar.timeoutMs
                });

                this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.room_leave_completed', {
                    roomId: config.roomId,
                    roomRef,
                    scope
                });
                return true;
            }
            catch (caught) {
                const error = toError(caught);
                cleanupErrors.push(toBlackBoxRallarSerializedError(error));
                this.#runtimeDiagnostics.emitError({
                    config: config,
                    topic: 'rallar.browser.cleanup.room_leave_failed',
                    error: error,
                    data: {
                        roomId: config.roomId,
                        roomRef,
                        scope
                    }
                });
            }
        }
        else if (config) {
            this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.room_leave_skipped', {
                roomId: config.roomId,
                leaveRoomOnClose: config.rallar.leaveRoomOnClose
            });
        }

        return false;
    };
    #disconnectForClose = async (
        config: BlackBoxRallarConnectionConfig | undefined
    ): Promise<RuntimeTransportCloseResult> => {
        if (config?.rallar.logoutOnClose) {
            this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.logout_started');
            await this.#rallar.auth.logout({
                timeoutMs: config.rallar.timeoutMs
            });

            this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.logout_completed');
            return { logout: true, disconnected: false };
        }
        else {
            if (config) {
                this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.disconnect_started');
            }
            await this.#rallar.disconnect();

            if (config) {
                this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.disconnect_completed');
            }
        }
        return { logout: false, disconnected: true };
    };
    #closeEffect = async (preparation: RuntimeClosePreparation): Promise<BlackBoxRallarCloseDiagnostics> => {
        const config = preparation.config;
        const cleanupErrors: BlackBoxRallarSerializedError[] = [];
        try {
            if (config) {
                this.#runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.started', {
                    roomId: config.roomId,
                    ...blackBoxRallarScopeDiagnosticsOf(config),
                    logoutOnClose: config.rallar.logoutOnClose === true,
                    leaveRoomOnClose: config.rallar.leaveRoomOnClose !== false
                });
            }

            const unsubscribed = await this.#closeResources(preparation, cleanupErrors);
            const leftRoom = await this.#leaveRoomForClose(config, cleanupErrors);

            const { logout, disconnected } = await this.#disconnectForClose(config);
            this.#connectionState.set(undefined);
            this.#consoleDiagnostics.close();
            const diagnostics: BlackBoxRallarCloseDiagnostics = {
                status: 'closed',
                connection: config?.connection,
                actor: config?.actor,
                transport: config ? resolveBlackBoxRallarTransport(config) : undefined,
                roomId: config?.roomId,
                ...(config ? blackBoxRallarScopeDiagnosticsOf(config) : {}),
                unsubscribed,
                leftRoom,
                logout,
                disconnected,
                cleanupErrors
            };
            this.#runtimeDiagnostics.emit({
                kind: 'close',
                topic: 'rallar.browser.closed',
                connection: config?.connection,
                actor: config?.actor,
                transport: config ? resolveBlackBoxRallarTransport(config) : undefined,
                roomId: config?.roomId,
                ...(config ? blackBoxRallarScopeDiagnosticsOf(config) : {}),
                data: diagnostics
            });
            return diagnostics;
        }
        catch (caught) {
            const error = toError(caught);
            this.#runtimeDiagnostics.emitError({ config: config, topic: 'rallar.browser.close_failed', error: error });
            throw error;
        }
    };
    #close = (): Promise<BlackBoxRallarCloseDiagnostics> => {
        const runtimeState = this.#connectionState.get();
        const activeCrdtOpens = this.#crdtController.pending();
        const authenticatedConfig = this.#authentication.getConfig();
        return this.#lifecycle.close(async (context) => {
            const configs = [
                runtimeState?.config,
                authenticatedConfig,
                context.authenticationConfig,
                this.#closeRetryConfig
            ];
            const baseConfig = configs.find(
                (config): config is BlackBoxRallarConnectionConfig => config !== undefined
            );
            const config = baseConfig
                ? configs.reduce<BlackBoxRallarConnectionConfig>(
                    (merged, candidate) =>
                        candidate
                            ? mergeBlackBoxRallarAuthenticationConfig(candidate, merged)
                            : merged,
                    baseConfig
                )
                : undefined;
            this.#closeRetryConfig = config;
            try {
                const diagnostics = await this.#closeEffect({ runtimeState, config });
                this.#authentication.clear();
                this.#closeRetryConfig = undefined;
                return diagnostics;
            }
            catch (caught) {
                const error = toError(caught);
                // Cleanup already dropped this runtime's subscriptions, so it
                // must stop naming the target it tried to leave. closeRetryConfig
                // survives so a later close can still reach that target.
                this.#connectionState.set(undefined);
                this.#authentication.clear();
                throw error;
            }
        }, activeCrdtOpens);
    };
    #refreshRoom = async (options: BlackBoxRallarRoomRefreshOptions): Promise<void> => {
        const config = this.#requireState().config;
        const roomRef = blackBoxRallarRoomRefOf(config);
        const scope = blackBoxRallarScopeOf(config);
        if (!roomRef || !scope) {
            throwRallarValidation([
                {
                    path: '$.roomRef',
                    code: 'room-ref-required',
                    message: 'Room refresh requires an exact room reference.'
                }
            ]);
        }

        await this.#rallar.refreshRoomState(roomRef, { ...options, scope });
    };
    installation(): BlackBoxRallarRuntimeInstallation {
        const runtime: BlackBoxRallarRuntime = {
            authenticate: this.#authentication.authenticate,
            connect: this.#connect,
            send: this.#messagingController.send,
            sendWs: this.#messagingController.sendWs,
            refreshRoom: this.#refreshRoom,
            readRtcMessageNacks: (messageId) => this.#rallar.readRtcMessageNacks(messageId),
            crdt: this.#crdtController,
            director: this.#directorController,
            formation: this.#formationController,
            close: this.#close,
            health: (input = {}) => {
                const config = this.#connectionState.get()?.config;
                const roomRef = config ? blackBoxRallarRoomRefOf(config) : undefined;
                return this.#healthReader.health({
                    input,
                    config,
                    crdt: this.#crdtController.summary(),
                    director: this.#directorController.summary(),
                    // Settled Q4: always present when a room resolves, and handed the resolved ref
                    // rather than a room id, so the one throwing path in the facade is unreachable
                    // on the two hot paths that call `health` from inside the runtime.
                    formation: roomRef ? this.#formationController.summary(roomRef) : undefined
                });
            }
        };
        return {
            runtime,
            emitRuntimeLoaded: () =>
                this.#runtimeDiagnostics.emit({
                    kind: 'diagnostic',
                    topic: 'rallar.browser.runtime_loaded'
                })
        };
    }
}

export function createBlackBoxRallarRuntime(options: BlackBoxRallarConnectionRuntime.Input): BlackBoxRallarRuntime {
    return new BlackBoxRallarConnectionRuntime(options).installation().runtime;
}

export function installBlackBoxRallarRuntime(
    targetWindow: BlackBoxRallarRuntimeInstallationTarget
): BlackBoxRallarRuntime {
    const installation = new BlackBoxRallarConnectionRuntime({
        facade: createBlackBoxBrowserRallarRuntimeDependency(),
        targetWindow,
        clock: { now: Date.now },
        delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))
    }).installation();
    targetWindow.__blackBoxRallar = installation.runtime;
    installation.emitRuntimeLoaded();
    return installation.runtime;
}
