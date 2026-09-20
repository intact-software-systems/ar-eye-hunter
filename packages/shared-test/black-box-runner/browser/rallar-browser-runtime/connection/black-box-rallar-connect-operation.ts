import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type {
    BlackBoxRallarConsoleDiagnostics,
    BlackBoxRallarRuntimeDiagnostics
} from '../black-box-rallar-diagnostics.ts';
import type {
    BlackBoxRallarConnectDiagnostics,
    BlackBoxRallarConnectionConfig
} from '../black-box-rallar-operation-contracts.ts';
import {
    blackBoxRallarConnectionOperationKeyOf,
    blackBoxRallarRoomRefOf,
    blackBoxRallarScopeDiagnosticsOf,
    blackBoxRallarScopeOf
} from '../black-box-rallar-operation-policy.ts';
import type { BlackBoxBrowserRallarRuntimeDependency } from '../browser-rallar-runtime-composition.ts';
import type { BlackBoxRallarFormationController } from '../formation/formation-controller.ts';
import type { BlackBoxRallarLifecycleOperationContext } from '../lifecycle-controller.ts';
import type { BlackBoxRallarTypedChannels } from '../messaging/black-box-rallar-typed-channels.ts';
import type { BlackBoxRallarAuthentication } from './black-box-rallar-authentication.ts';
import {
    isBlackBoxRallarTypedMessagesTransport,
    resolveBlackBoxRallarLaneId,
    resolveBlackBoxRallarMessageSelector,
    resolveBlackBoxRallarTopicId,
    resolveBlackBoxRallarTransport,
    resolveBlackBoxRallarTypeId,
    toBlackBoxRallarAuthenticationKey,
    toBlackBoxRallarSessionDiagnostic,
    toConnectedTargetRejection
} from './black-box-rallar-connection-policy.ts';
import type { BlackBoxRallarConnectionState } from './black-box-rallar-connection-state.ts';
import type { BlackBoxRallarConnectionSubscriptions } from './black-box-rallar-connection-subscriptions.ts';
import type { BlackBoxRallarHealthReader } from './black-box-rallar-health-reader.ts';
import { configureBlackBoxRallarConnection } from './configure-black-box-rallar-connection.ts';

type LifecycleSubscriptions = Pick<
    BlackBoxRallarConnectionState.Value,
    'unsubscribeWsLifecycle' | 'unsubscribeRtcLifecycle' | 'unsubscribeFormationDiagnostics'
>;

interface ConnectionAttempt {
    readonly config: BlackBoxRallarConnectionConfig;
    readonly context: BlackBoxRallarLifecycleOperationContext;
    phase: string;
    lifecycleSubscriptions: LifecycleSubscriptions | undefined;
    unsubscribeConsoleDiagnostics: (() => void) | undefined;
}

export namespace BlackBoxRallarConnectOperation {
    export interface Input {
        readonly rallar: BlackBoxBrowserRallarRuntimeDependency;
        readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
        readonly diagnosticsPorts: RallarDiagnosticsPorts;
        readonly lifecycle: BlackBoxRallarConnectionState.Lifecycle;
        readonly connectionState: BlackBoxRallarConnectionState;
        readonly authentication: BlackBoxRallarAuthentication;
        readonly health: BlackBoxRallarHealthReader;
        readonly consoleDiagnostics: BlackBoxRallarConsoleDiagnostics<BlackBoxRallarConnectionConfig>;
        readonly formation: BlackBoxRallarFormationController;
        readonly typedChannels: BlackBoxRallarTypedChannels;
        readonly subscriptions: BlackBoxRallarConnectionSubscriptions;
    }
}

export class BlackBoxRallarConnectOperation {
    readonly #input: BlackBoxRallarConnectOperation.Input;

    constructor(input: BlackBoxRallarConnectOperation.Input) {
        this.#input = input;
    }

    connect = (config: BlackBoxRallarConnectionConfig): Promise<BlackBoxRallarConnectDiagnostics> => {
        const { lifecycle, connectionState } = this.#input;
        const activeAuthentication = lifecycle.authenticationConfig();
        if (
            activeAuthentication &&
            toBlackBoxRallarAuthenticationKey(activeAuthentication) !== toBlackBoxRallarAuthenticationKey(config)
        ) {
            return lifecycle.waitForAuthentication().then(() => this.connect(config), () => this.connect(config));
        }
        const immediateRejection = toConnectedTargetRejection(connectionState.get(), config);
        if (immediateRejection) {
            return Promise.reject(immediateRejection);
        }
        return lifecycle.runConnect(blackBoxRallarConnectionOperationKeyOf(config), (context) => {
            const queuedRejection = toConnectedTargetRejection(connectionState.get(), config);
            return queuedRejection ? Promise.reject(queuedRejection) : this.#runConnect(config, context);
        });
    };

    async #runConnect(
        config: BlackBoxRallarConnectionConfig,
        context: BlackBoxRallarLifecycleOperationContext
    ): Promise<BlackBoxRallarConnectDiagnostics> {
        const attempt: ConnectionAttempt = {
            config,
            context,
            phase: 'validate-config',
            lifecycleSubscriptions: undefined,
            unsubscribeConsoleDiagnostics: undefined
        };
        try {
            return await this.#connectAttempt(attempt);
        }
        catch (caught) {
            const error = toError(caught);
            this.#recordConnectionFailure(attempt, error);
            throw error;
        }
    }

    async #connectAttempt(attempt: ConnectionAttempt): Promise<BlackBoxRallarConnectDiagnostics> {
        const { config, context } = attempt;
        const { diagnostics, connectionState } = this.#input;
        if (!config.rallar.apiBaseUrl) {
            throw new Error('rallar.apiBaseUrl is required.');
        }
        diagnostics.emitDiagnostic(config, 'rallar.browser.connect_started');
        attempt.unsubscribeConsoleDiagnostics = this.#input.consoleDiagnostics.install(config);
        this.#prepareConnection(attempt);
        attempt.phase = 'auth';
        const session = connectionState.get()?.session ??
            (await this.#input.authentication.sessionForAuthentication(config));
        context.assertCurrent();
        diagnostics.emitDiagnostic(config, 'rallar.browser.authenticated', {
            clientId: session.clientId,
            sessionId: session.sessionId,
            username: session.username
        });
        const previousState = connectionState.get();
        this.#recordSessionChange(config, session, previousState);
        attempt.lifecycleSubscriptions = this.#installLifecycleDiagnostics(config);
        await this.#openConnection(attempt);
        const state = this.#subscribeConnection(attempt, session);
        this.#input.subscriptions.stop({ state: previousState, config });
        if (isBlackBoxRallarTypedMessagesTransport(resolveBlackBoxRallarTransport(config))) {
            this.#input.typedChannels.subscribe(config);
        }
        connectionState.set(state);
        const connected = this.#toConnectDiagnostics(state);
        diagnostics.emitDiagnostic(config, 'rallar.browser.connect_completed', connected);
        return connected;
    }

    #prepareConnection(attempt: ConnectionAttempt): void {
        const { config } = attempt;
        const { diagnostics } = this.#input;
        const transport = resolveBlackBoxRallarTransport(config);
        const typedMessages = isBlackBoxRallarTypedMessagesTransport(transport);
        attempt.phase = 'transport-config';
        diagnostics.emitConnectPhaseStarted(config, attempt.phase, { transport });
        diagnostics.emitConnectPhaseCompleted(config, attempt.phase, {
            transport,
            laneId: transport === 'realtime' ? resolveBlackBoxRallarLaneId(config) : undefined,
            typeId: typedMessages ? resolveBlackBoxRallarTypeId(config) : undefined,
            topicId: typedMessages ? resolveBlackBoxRallarTopicId(config) : undefined
        });

        attempt.phase = 'configure';
        diagnostics.emitConnectPhaseStarted(config, attempt.phase, {
            apiBaseUrl: config.rallar.apiBaseUrl,
            ...blackBoxRallarScopeDiagnosticsOf(config)
        });
        this.#input.authentication.requireCredentialsForAuthenticationIdentityChange(config);
        const defaults = configureBlackBoxRallarConnection({
            rallar: this.#input.rallar,
            diagnosticsPorts: this.#input.diagnosticsPorts,
            config
        });
        diagnostics.emitConnectPhaseCompleted(config, attempt.phase, { defaults });
    }

    async #openConnection(attempt: ConnectionAttempt): Promise<void> {
        const { config, context } = attempt;
        const { rallar, diagnostics, health } = this.#input;
        attempt.phase = 'rallar-connect';
        diagnostics.emitConnectPhaseStarted(config, attempt.phase, {
            timeoutMs: config.rallar.timeoutMs,
            dataChannelLanes: config.rallar.dataChannelLanes,
            ...health.getStatusDiagnostics(config)
        });
        await rallar.connect({ timeoutMs: config.rallar.timeoutMs, dataChannelLanes: config.rallar.dataChannelLanes });
        context.assertCurrent();
        diagnostics.emitConnectPhaseCompleted(config, attempt.phase, { ...health.getStatusDiagnostics(config) });
        if (!config.roomId) {
            return;
        }

        const roomContext = {
            roomId: config.roomId,
            roomRef: blackBoxRallarRoomRefOf(config),
            scope: blackBoxRallarScopeOf(config)
        };
        attempt.phase = 'room-join';
        diagnostics.emitConnectPhaseStarted(config, attempt.phase, roomContext);
        await rallar.rooms.join(config.roomId, { timeoutMs: config.rallar.timeoutMs, scope: roomContext.scope });
        context.assertCurrent();
        diagnostics.emitConnectPhaseCompleted(config, attempt.phase, {
            ...roomContext,
            ...health.getStatusDiagnostics(config)
        });
    }

    #subscribeConnection(
        attempt: ConnectionAttempt,
        session: BlackBoxRallarConnectionState.Session
    ): BlackBoxRallarConnectionState.Value {
        const { config } = attempt;
        const { diagnostics } = this.#input;
        const transport = resolveBlackBoxRallarTransport(config);
        const typedMessages = isBlackBoxRallarTypedMessagesTransport(transport);
        const phaseData = {
            laneId: transport === 'realtime' ? resolveBlackBoxRallarLaneId(config) : undefined,
            typeId: typedMessages ? resolveBlackBoxRallarTypeId(config) : undefined,
            topicId: typedMessages ? resolveBlackBoxRallarTopicId(config) : undefined
        };
        attempt.phase = transport === 'realtime' ? 'subscribe-realtime' : `subscribe-${transport}`;
        diagnostics.emitConnectPhaseStarted(config, attempt.phase, {
            ...phaseData,
            selector: transport === 'messages.rtc' ? resolveBlackBoxRallarMessageSelector(config) : undefined
        });
        const unsubscribeRealtime = this.#input.subscriptions.subscribeRealtime({ config, session });
        const unsubscribeMessagesRtc = this.#input.subscriptions.subscribeMessagesRtc({ config, session });
        diagnostics.emitConnectPhaseCompleted(config, attempt.phase, {
            ...phaseData,
            ...this.#input.health.getStatusDiagnostics(config)
        });
        return {
            config,
            session,
            unsubscribeRealtime,
            unsubscribeMessagesRtc,
            unsubscribeConsoleDiagnostics: attempt.unsubscribeConsoleDiagnostics,
            ...attempt.lifecycleSubscriptions
        };
    }

    #recordSessionChange(
        config: BlackBoxRallarConnectionConfig,
        session: BlackBoxRallarConnectionState.Session,
        previousState: BlackBoxRallarConnectionState.Value | undefined
    ): void {
        const { diagnostics } = this.#input;
        const expectedSessionId = config.rallar.expectedSessionId;
        if (expectedSessionId && expectedSessionId !== session.sessionId) {
            diagnostics.emitDiagnostic(config, 'rallar.browser.session.expected_mismatch', {
                expectedSessionId,
                actualSessionId: session.sessionId,
                username: session.username
            });
        }
        if (!previousState) {
            return;
        }
        const previous = {
            previousConnection: previousState.config.connection,
            previousRoomId: previousState.config.roomId
        };
        if (previousState.session.sessionId === session.sessionId) {
            diagnostics.emitDiagnostic(config, 'rallar.browser.session.duplicate_detected', {
                session: toBlackBoxRallarSessionDiagnostic(session),
                ...previous
            });
            return;
        }
        diagnostics.emitDiagnostic(config, 'rallar.browser.session.active_replaced', {
            previousSession: toBlackBoxRallarSessionDiagnostic(previousState.session),
            nextSession: toBlackBoxRallarSessionDiagnostic(session),
            ...previous
        });
    }

    /** The formation stream is room-scoped, so a connection that names no room installs none. */
    #installLifecycleDiagnostics(config: BlackBoxRallarConnectionConfig): LifecycleSubscriptions {
        const { rallar, diagnostics, formation } = this.#input;
        const roomRef = blackBoxRallarRoomRefOf(config);
        return {
            ...(roomRef ? { unsubscribeFormationDiagnostics: formation.installDiagnostics(roomRef) } : {}),
            unsubscribeWsLifecycle: rallar.ws.onLifecycle(
                (event) => diagnostics.emitDiagnostic(config, 'rallar.browser.ws.lifecycle', event),
                { emitCurrent: true }
            ),
            unsubscribeRtcLifecycle: rallar.rtc.onLifecycle(
                (event) => diagnostics.emitDiagnostic(config, 'rallar.browser.rtc.lifecycle', event),
                { emitCurrent: true }
            )
        };
    }

    #toConnectDiagnostics(state: BlackBoxRallarConnectionState.Value): BlackBoxRallarConnectDiagnostics {
        const { config, session } = state;
        const { health } = this.#input;
        const transport = resolveBlackBoxRallarTransport(config);
        const typedMessages = isBlackBoxRallarTypedMessagesTransport(transport);
        return {
            status: 'connected',
            document: health.readDocument(),
            connection: config.connection,
            actor: config.actor,
            transport,
            roomId: config.roomId,
            ...blackBoxRallarScopeDiagnosticsOf(config),
            clientId: session.clientId,
            sessionId: session.sessionId,
            username: session.username,
            laneId: transport === 'realtime' ? resolveBlackBoxRallarLaneId(config) : undefined,
            typeId: typedMessages ? resolveBlackBoxRallarTypeId(config) : undefined,
            topicId: typedMessages ? resolveBlackBoxRallarTopicId(config) : undefined,
            wsStatus: health.getWsStatus(),
            rtcStatus: health.getRtcStatus(config),
            health: health.getLaneHealth(config)
        };
    }

    #recordConnectionFailure(attempt: ConnectionAttempt, error: Error): void {
        const { config, phase } = attempt;
        attempt.lifecycleSubscriptions?.unsubscribeFormationDiagnostics?.();
        attempt.lifecycleSubscriptions?.unsubscribeRtcLifecycle?.();
        attempt.lifecycleSubscriptions?.unsubscribeWsLifecycle?.();
        attempt.unsubscribeConsoleDiagnostics?.();
        this.#input.diagnostics.emitError({
            config,
            topic: 'rallar.browser.connect.phase_failed',
            error,
            data: { phase }
        });
        this.#input.diagnostics.emitError({ config, topic: 'rallar.browser.connect_failed', error, data: { phase } });
    }
}
