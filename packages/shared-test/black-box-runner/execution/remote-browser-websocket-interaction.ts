import type { ControlResultEnvelope } from '../../rallar-bb-test/control-protocol.ts';
import type {
    RallarBlackBoxTestWsCloseCommand,
    RallarBlackBoxTestWsOpenCommand,
    RallarBlackBoxTestWsSendCommand
} from '../../rallar-bb-test/types.ts';
import type { WaitObservationSource } from '../expectations/wait-observation-source.ts';
import {
    executeRallarRemoteBrowserCommand,
    readRallarRemoteBrowserConfig,
    RemoteBrowserObservationSync,
    syncRallarRemoteBrowserEvents,
    type RallarRemoteBrowserConfig,
    type RallarRemoteBrowserControlFetch
} from '../rallar-remote-browser-provider.ts';
import { toRallarRemoteBrowserCommandId } from '../remote-browser/remote-browser-commands.ts';
import type { WsInteractionConfig } from '../ws/ws-interaction-statuses.ts';
import {
    toWsConnectionName,
    toWsExpectedConnectionName,
    toWsFailureStatus,
    toWsSuccessStatus
} from '../ws/ws-interaction-statuses.ts';
import {
    waitForWsClose,
    waitForWsMessage,
    waitForWsMessageAbsence,
    waitForWsMessageCount,
    waitForWsMessages,
    type WsInteraction,
    type WsInteractionRequest,
    type WsInteractionResult,
    type WsWaitContext
} from '../ws/ws-wait-expectations.ts';
import {
    assertRemoteDestinationAllowed,
    assertRemotePayloadWithinLimit,
    isRallarRemoteBrowserRequest,
    remoteBrowserFetch,
    remoteBrowserOptions,
    remoteResultValue
} from './remote-browser-execution.ts';

namespace RemoteWsConnection {
    export interface Input {
        readonly url: string;
        readonly commandId: string;
        readonly remote: RallarRemoteBrowserConfig;
        readonly fetchFn: RallarRemoteBrowserControlFetch;
        readonly context: RemoteWsContext;
        readonly interaction: WsInteraction;
    }
}

class RemoteWsConnection {
    readonly remote = true;
    readonly readyState = 1;
    readonly url: string;
    readonly #input: RemoteWsConnection.Input;

    constructor(input: RemoteWsConnection.Input) {
        this.#input = input;
        this.url = input.url;
    }

    async close(code?: number, reason?: string): Promise<void> {
        const { remote, fetchFn, context, interaction, commandId } = this.#input;
        invalidateRemoteWsObservations(toWsConnectionName(interaction.request), context);
        const result = await executeRallarRemoteBrowserCommand({
            remote: remote,
            fetchFn: fetchFn,
            context: context,
            command: {
                ...toRemoteWsCloseCommand(`${commandId}-auto-close`, interaction),
                code,
                reason
            }
        });
        if (!result.ok) {
            throw new Error(result.error?.message ?? 'Remote WebSocket close failed');
        }
    }
}

interface RemoteWsContext extends WsWaitContext {
    readonly wsConnections: Record<string, RemoteWsConnection | WebSocket | undefined>;
    readonly wsCloseEvents: Record<string, unknown[] | undefined>;
}

function toWsUrl(request: WsInteractionRequest): string | undefined {
    return request.url || request.path;
}

function toRemoteWsPayload(request: WsInteractionRequest): unknown {
    return request.send !== undefined
        ? request.send
        : request.message !== undefined
        ? request.message
        : request.body;
}

function toRemoteWsOpenCommand(
    commandId: string,
    interaction: WsInteraction,
    context: RemoteWsContext
): RallarBlackBoxTestWsOpenCommand {
    const request = interaction.request;
    const url = toWsUrl(request);
    assertRemoteDestinationAllowed({ request, context, url, label: 'WebSocket' });
    return {
        kind: 'ws.open',
        commandId,
        connection: toWsConnectionName(request),
        url,
        protocols: request.protocols,
        headers: request.headers,
        timeoutMs: request.timeoutMs === undefined ? undefined : Number(request.timeoutMs),
        metadata: {
            blackBoxRunner: request
        }
    };
}

function toRemoteWsSendCommand(
    commandId: string,
    interaction: WsInteraction,
    context: RemoteWsContext
): RallarBlackBoxTestWsSendCommand {
    const request = interaction.request;
    const data = toRemoteWsPayload(request);
    assertRemotePayloadWithinLimit({ request, context, value: data, label: 'WebSocket send' });
    return {
        kind: 'ws.send',
        commandId,
        connection: toWsConnectionName(request),
        data,
        timeoutMs: request.timeoutMs === undefined ? undefined : Number(request.timeoutMs),
        metadata: {
            blackBoxRunner: request
        }
    };
}

function toRemoteWsCloseCommand(
    commandId: string,
    interaction: WsInteraction
): RallarBlackBoxTestWsCloseCommand {
    const request = interaction.request;
    return {
        kind: 'ws.close',
        commandId,
        connection: toWsConnectionName(request),
        code: request.closeCode !== undefined ? request.closeCode : request.code,
        reason: request.closeReason !== undefined ? request.closeReason : request.reason,
        timeoutMs: request.timeoutMs === undefined ? undefined : Number(request.timeoutMs),
        metadata: {
            blackBoxRunner: request
        }
    };
}

function readRemoteWsConfig(
    interaction: WsInteraction,
    config: WsInteractionConfig,
    context: RemoteWsContext
): RallarRemoteBrowserConfig {
    return readRallarRemoteBrowserConfig({
        request: interaction.request,
        config: config,
        context: context,
        options: remoteBrowserOptions(context)
    });
}

function isRemoteWsConnection(context: RemoteWsContext, connectionName: string): boolean {
    const connection = context.wsConnections[connectionName];
    return connection !== undefined && 'remote' in connection && connection.remote;
}

export function shouldExecuteRemoteWsInteraction(interaction: WsInteraction, context: RemoteWsContext): boolean {
    const action = interaction.request.action || 'send';
    const connectionName = action === 'wait' || action === 'expect'
        ? toWsExpectedConnectionName(interaction)
        : toWsConnectionName(interaction.request);
    return isRallarRemoteBrowserRequest(interaction.request) ||
        isRemoteWsConnection(context, connectionName);
}

function invalidateRemoteWsObservations(connectionName: string, context: RemoteWsContext): void {
    const losses = context.wsObservationLoss ??= {};
    losses[connectionName] = (losses[connectionName] ?? 0) + 1;
    context.wsMessages[connectionName] = [];
}

interface WaitWithRemoteWsEventSyncInput {
    readonly observations?: WaitObservationSource;
    readonly remote: RallarRemoteBrowserConfig;
    readonly fetchFn: RallarRemoteBrowserControlFetch;
    readonly context: RemoteWsContext;
    readonly interaction: WsInteraction;
    readonly config: WsInteractionConfig;
    readonly details?: Readonly<Record<string, unknown>>;
}

async function waitWithRemoteWsEventSync(input: WaitWithRemoteWsEventSyncInput): Promise<WsInteractionResult> {
    const { remote, fetchFn, context } = input;
    await syncRallarRemoteBrowserEvents(remote, fetchFn, context);
    const observations = new RemoteBrowserObservationSync({ kind: 'events', remote, fetchFn, context });
    observations.start();
    try {
        try {
            return await waitForRemoteWsExpectation({ ...input, observations });
        }
        finally {
            await observations.stop();
        }
    }
    catch (error) {
        const connections = new Set([
            ...Object.keys(context.wsConnections),
            toWsExpectedConnectionName(input.interaction)
        ]);
        const losses = context.wsObservationLoss ??= {};
        for (const connection of connections) {
            losses[connection] = (losses[connection] ?? 0) + 1;
        }
        return toWsFailureStatus({
            config: input.config,
            interaction: input.interaction,
            result: 'WebSocket observations were discarded because remote polling failed',
            details: { ...input.details, exception: error instanceof Error ? error.message : String(error) }
        });
    }
}

async function openRemoteWs(
    interaction: WsInteraction,
    config: WsInteractionConfig,
    context: RemoteWsContext
): Promise<WsInteractionResult> {
    const connectionName = toWsConnectionName(interaction.request);
    const url = toWsUrl(interaction.request);

    if (!url) {
        return toWsFailureStatus({ config, interaction, result: 'WebSocket URL is missing', details: {} });
    }

    const remote = readRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    const identity = toRallarRemoteBrowserCommandId('ws-open', interaction);
    if (identity.right === undefined) {
        return toWsFailureStatus({
            config,
            interaction,
            result: 'Remote WebSocket connect failed',
            details: { exception: identity.left?.message }
        });
    }
    const commandId = identity.right;

    try {
        const command = toRemoteWsOpenCommand(commandId, interaction, context);
        const result = await executeRallarRemoteBrowserCommand({ remote, fetchFn, context, command });
        return completeRemoteWsOpen({ interaction, config, context, remote, fetchFn, commandId, url, result });
    }
    catch (error) {
        return toWsFailureStatus({
            config,
            interaction,
            result: 'Remote WebSocket connect failed',
            details: {
                connection: connectionName,
                remote,
                exception: error instanceof Error ? error.message : String(error)
            }
        });
    }
}

interface RemoteWsOpenCompletion extends RemoteWsConnection.Input {
    readonly config: WsInteractionConfig;
    readonly result: ControlResultEnvelope;
}

function completeRemoteWsOpen(input: RemoteWsOpenCompletion): WsInteractionResult {
    const { interaction, config, context, remote, fetchFn, commandId, url, result } = input;
    const connectionName = toWsConnectionName(interaction.request);
    if (!result.ok) {
        return toWsFailureStatus({
            config,
            interaction,
            result: 'Remote WebSocket connect failed',
            details: {
                connection: connectionName,
                remote,
                result
            }
        });
    }

    invalidateRemoteWsObservations(connectionName, context);
    context.wsConnections[connectionName] = new RemoteWsConnection({
        url,
        commandId,
        remote,
        fetchFn,
        context,
        interaction
    });
    context.wsCloseEvents[connectionName] ??= [];

    return toWsSuccessStatus(config, interaction, {
        connection: connectionName,
        url,
        readyState: 1,
        remote,
        commandId,
        result: remoteResultValue(result)
    });
}

interface RemoteWsSendObservation {
    readonly remote: RallarRemoteBrowserConfig;
    readonly commandId: string;
    readonly connection: string;
    readonly sent: unknown;
    readonly result: ControlResultEnvelope;
    readonly sendStartedAtEpochMs: number;
    readonly sendEndedAtEpochMs: number;
}

interface RemoteWsSendDetails {
    readonly sentConnection: string;
    readonly sent: unknown;
    readonly remote: RallarRemoteBrowserConfig;
    readonly commandId: string;
    readonly result: unknown;
    readonly sendResult: {
        readonly status: 'sent' | 'failed';
        readonly connection: string;
        readonly remoteResult: unknown;
    };
    readonly sendStartedAtEpochMs: number;
    readonly sendEndedAtEpochMs: number;
    readonly sendLatencyMs: number;
}

interface RemoteWsSendSubmission extends WaitWithRemoteWsEventSyncInput {
    readonly commandId: string;
}

async function sendRemoteWsCommand(input: RemoteWsSendSubmission): Promise<RemoteWsSendObservation> {
    const { interaction, remote, fetchFn, context, commandId } = input;
    const command = toRemoteWsSendCommand(commandId, interaction, context);
    const sendStartedAtEpochMs = context.dependencies.now();
    const result = await executeRallarRemoteBrowserCommand({
        remote: remote,
        fetchFn: fetchFn,
        context: context,
        command: command
    });
    return {
        remote,
        commandId,
        connection: toWsConnectionName(interaction.request),
        sent: command.data,
        result,
        sendStartedAtEpochMs,
        sendEndedAtEpochMs: context.dependencies.now()
    };
}

function computeRemoteWsSendDetails(observation: RemoteWsSendObservation): RemoteWsSendDetails {
    return {
        sentConnection: observation.connection,
        sent: observation.sent,
        remote: observation.remote,
        commandId: observation.commandId,
        result: remoteResultValue(observation.result),
        sendResult: {
            status: observation.result.ok ? 'sent' : 'failed',
            connection: observation.connection,
            remoteResult: remoteResultValue(observation.result)
        },
        sendStartedAtEpochMs: observation.sendStartedAtEpochMs,
        sendEndedAtEpochMs: observation.sendEndedAtEpochMs,
        sendLatencyMs: observation.sendEndedAtEpochMs - observation.sendStartedAtEpochMs
    };
}

async function sendRemoteWs(
    interaction: WsInteraction,
    config: WsInteractionConfig,
    context: RemoteWsContext
): Promise<WsInteractionResult> {
    const connectionName = toWsConnectionName(interaction.request);
    if (!context.wsConnections[connectionName]) {
        return toWsFailureStatus({
            config,
            interaction,
            result: 'WebSocket connection is not open',
            details: {
                connection: connectionName
            }
        });
    }
    const remote = readRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    const identity = toRallarRemoteBrowserCommandId('ws-send', interaction);
    if (identity.right === undefined) {
        return toRemoteWsSendException({ interaction, config, remote, connectionName, error: identity.left });
    }
    const commandId = identity.right;
    try {
        const observation = await sendRemoteWsCommand({ interaction, config, context, remote, fetchFn, commandId });
        const details = computeRemoteWsSendDetails(observation);
        if (!observation.result.ok) {
            return toWsFailureStatus({
                config,
                interaction,
                result: 'Remote WebSocket send failed',
                details: {
                    ...details,
                    connection: connectionName,
                    result: observation.result
                }
            });
        }
        if (
            interaction.response?.count !== undefined || interaction.response?.messages || interaction.response?.message
        ) {
            return waitWithRemoteWsEventSync({
                remote,
                fetchFn,
                context,
                interaction,
                config,
                details: { ...details }
            });
        }
        await syncRallarRemoteBrowserEvents(remote, fetchFn, context);
        return toWsSuccessStatus(config, interaction, { ...details, connection: connectionName });
    }
    catch (error) {
        return toRemoteWsSendException({ interaction, config, remote, connectionName, error });
    }
}

interface RemoteWsSendException {
    readonly interaction: WsInteraction;
    readonly config: WsInteractionConfig;
    readonly remote: RallarRemoteBrowserConfig;
    readonly connectionName: string;
    readonly error: unknown;
}

function toRemoteWsSendException(input: RemoteWsSendException): WsInteractionResult {
    const { interaction, config, remote, connectionName, error } = input;
    const exception = error instanceof Error ? error.message : String(error);
    return toWsFailureStatus({
        config,
        interaction,
        result: 'Remote WebSocket send failed',
        details: {
            connection: connectionName,
            remote,
            sent: toRemoteWsPayload(interaction.request),
            sendResult: { status: 'failed', connection: connectionName, exception },
            exception
        }
    });
}

function waitForRemoteWsExpectation(input: WaitWithRemoteWsEventSyncInput): Promise<WsInteractionResult> {
    const { interaction, config, context, observations, details = { remote: input.remote } } = input;
    if (interaction.response?.absent !== undefined) {
        return waitForWsMessageAbsence({
            interaction,
            config,
            context,
            details,
            observations,
            observeCloseEvents: true
        });
    }
    if (interaction.response?.count !== undefined) {
        return waitForWsMessageCount({ interaction, config, context, details, observations, observeCloseEvents: true });
    }
    if (interaction.response?.close !== undefined) {
        return waitForWsClose({ interaction, config, context, details });
    }
    if (interaction.response?.messages) {
        return waitForWsMessages({ interaction, config, context, details });
    }
    if (interaction.response?.message) {
        return waitForWsMessage({ interaction, config, context, details });
    }
    return Promise.resolve(
        toWsFailureStatus({
            config,
            interaction,
            result:
                'WebSocket wait expects expect.message, expect.messages, expect.count, expect.absent, or expect.close'
        })
    );
}

async function waitRemoteWs(
    interaction: WsInteraction,
    config: WsInteractionConfig,
    context: RemoteWsContext
): Promise<WsInteractionResult> {
    const remote = readRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    return await waitWithRemoteWsEventSync({ remote, fetchFn, context, interaction, config });
}

async function closeRemoteWs(
    interaction: WsInteraction,
    config: WsInteractionConfig,
    context: RemoteWsContext
): Promise<WsInteractionResult> {
    const connectionName = toWsConnectionName(interaction.request);
    const remote = readRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    const identity = toRallarRemoteBrowserCommandId('ws-close', interaction);
    if (identity.right === undefined) {
        return toWsFailureStatus({
            config,
            interaction,
            result: 'Remote WebSocket close failed',
            details: { exception: identity.left?.message }
        });
    }
    const commandId = identity.right;
    const command = toRemoteWsCloseCommand(commandId, interaction);

    try {
        const result = await executeRallarRemoteBrowserCommand({ remote, fetchFn, context, command });
        await syncRallarRemoteBrowserEvents(remote, fetchFn, context);
        if (!result.ok) {
            return toWsFailureStatus({
                config,
                interaction,
                result: 'Remote WebSocket close failed',
                details: { connection: connectionName, remote, result }
            });
        }

        invalidateRemoteWsObservations(connectionName, context);
        delete context.wsConnections[connectionName];

        return toWsSuccessStatus(config, interaction, {
            connection: connectionName,
            closeRequested: true,
            closed: true,
            remote,
            commandId,
            result: remoteResultValue(result)
        });
    }
    catch (error) {
        return toWsFailureStatus({
            config,
            interaction,
            result: 'Remote WebSocket close failed',
            details: {
                connection: connectionName,
                remote,
                exception: error instanceof Error ? error.message : String(error)
            }
        });
    }
}

export function executeRemoteWsInteraction(
    interaction: WsInteraction,
    config: WsInteractionConfig,
    context: RemoteWsContext
): Promise<WsInteractionResult> {
    const action = interaction.request.action || 'send';

    if (action === 'connect' || action === 'open') {
        return openRemoteWs(interaction, config, context);
    }

    if (action === 'send') {
        return sendRemoteWs(interaction, config, context);
    }

    if (action === 'wait' || action === 'expect') {
        return waitRemoteWs(interaction, config, context);
    }

    if (action === 'close') {
        return closeRemoteWs(interaction, config, context);
    }

    return Promise.resolve(
        toWsFailureStatus({ config, interaction, result: 'Unsupported WebSocket action: ' + action, details: {} })
    );
}
