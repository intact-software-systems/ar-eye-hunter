import type {
    RallarBlackBoxTestWsCloseCommand,
    RallarBlackBoxTestWsOpenCommand,
    RallarBlackBoxTestWsSendCommand
} from '../../rallar-bb-test/types.ts';
import {
    executeRallarRemoteBrowserCommand,
    readRallarRemoteBrowserConfig,
    syncRallarRemoteBrowserEvents,
    type RallarRemoteBrowserConfig,
    type RallarRemoteBrowserControlFetch,
    type RallarRemoteBrowserControlResultEnvelope
} from '../rallar-remote-browser-provider.ts';
import { toRallarRemoteBrowserCommandId } from '../remote-browser/remote-browser-commands.ts';
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

    close(code?: number, reason?: string): void {
        const { remote, fetchFn, context, interaction, commandId } = this.#input;
        invalidateRemoteWsObservations(toWsConnectionName(interaction.request), context);
        void executeRallarRemoteBrowserCommand({
            remote: remote,
            fetchFn: fetchFn,
            context: context,
            command: {
                ...toRemoteWsCloseCommand(`${commandId}-auto-close`, interaction),
                code,
                reason
            }
        });
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
    config: unknown,
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

function startRemoteWsEventSync(
    remote: RallarRemoteBrowserConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: RemoteWsContext
): ReturnType<typeof setInterval> {
    let syncing = false;
    return setInterval(() => {
        if (syncing) {
            return;
        }
        syncing = true;
        void syncRallarRemoteBrowserEvents(remote, fetchFn, context)
            .catch(() => {
                for (const connectionName of Object.keys(context.wsConnections)) {
                    const losses = context.wsObservationLoss ??= {};
                    losses[connectionName] = (losses[connectionName] ?? 0) + 1;
                }
            })
            .finally(() => {
                syncing = false;
            });
    }, remote.pollIntervalMs);
}

interface WaitWithRemoteWsEventSyncInput {
    readonly remote: RallarRemoteBrowserConfig;
    readonly fetchFn: RallarRemoteBrowserControlFetch;
    readonly context: RemoteWsContext;
    readonly interaction: WsInteraction;
    readonly config: unknown;
    readonly details?: Readonly<Record<string, unknown>>;
}

async function waitWithRemoteWsEventSync(input: WaitWithRemoteWsEventSyncInput): Promise<WsInteractionResult> {
    const { remote, fetchFn, context } = input;
    await syncRallarRemoteBrowserEvents(remote, fetchFn, context);
    const interval = startRemoteWsEventSync(remote, fetchFn, context);
    try {
        return await waitForRemoteWsExpectation(input);
    }
    finally {
        clearInterval(interval);
    }
}

async function openRemoteWs(
    interaction: WsInteraction,
    config: unknown,
    context: RemoteWsContext
): Promise<WsInteractionResult> {
    const connectionName = toWsConnectionName(interaction.request);
    const url = toWsUrl(interaction.request);

    if (!url) {
        return toWsFailureStatus(config, interaction, 'WebSocket URL is missing', {});
    }

    const remote = readRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    const commandId = toRallarRemoteBrowserCommandId('ws-open', interaction);

    try {
        const command = toRemoteWsOpenCommand(commandId, interaction, context);
        const result = await executeRallarRemoteBrowserCommand({
            remote: remote,
            fetchFn: fetchFn,
            context: context,
            command: command
        });
        if (!result.ok) {
            return toWsFailureStatus(config, interaction, 'Remote WebSocket connect failed', {
                connection: connectionName,
                remote,
                result
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
    catch (error) {
        return toWsFailureStatus(config, interaction, 'Remote WebSocket connect failed', {
            connection: connectionName,
            remote,
            exception: error instanceof Error ? error.message : String(error)
        });
    }
}

interface RemoteWsSendObservation {
    readonly remote: RallarRemoteBrowserConfig;
    readonly commandId: string;
    readonly connection: string;
    readonly sent: unknown;
    readonly result: RallarRemoteBrowserControlResultEnvelope;
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

async function sendRemoteWsCommand(input: WaitWithRemoteWsEventSyncInput): Promise<RemoteWsSendObservation> {
    const { interaction, remote, fetchFn, context } = input;
    const commandId = toRallarRemoteBrowserCommandId('ws-send', interaction);
    const command = toRemoteWsSendCommand(commandId, interaction, context);
    const sendStartedAtEpochMs = Date.now();
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
        sendEndedAtEpochMs: Date.now()
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
    config: unknown,
    context: RemoteWsContext
): Promise<WsInteractionResult> {
    const connectionName = toWsConnectionName(interaction.request);
    if (!context.wsConnections[connectionName]) {
        return toWsFailureStatus(config, interaction, 'WebSocket connection is not open', {
            connection: connectionName
        });
    }
    const remote = readRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    try {
        const observation = await sendRemoteWsCommand({ interaction, config, context, remote, fetchFn });
        const details = computeRemoteWsSendDetails(observation);
        if (!observation.result.ok) {
            return toWsFailureStatus(config, interaction, 'Remote WebSocket send failed', {
                ...details,
                connection: connectionName,
                result: observation.result
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
        const exception = error instanceof Error ? error.message : String(error);
        return toWsFailureStatus(config, interaction, 'Remote WebSocket send failed', {
            connection: connectionName,
            remote,
            sent: toRemoteWsPayload(interaction.request),
            sendResult: { status: 'failed', connection: connectionName, exception },
            exception
        });
    }
}

function waitForRemoteWsExpectation(input: WaitWithRemoteWsEventSyncInput): Promise<WsInteractionResult> {
    const { interaction, config, context, details = { remote: input.remote } } = input;
    if (interaction.response?.absent !== undefined) {
        return waitForWsMessageAbsence({ interaction, config, context, details, observeCloseEvents: true });
    }
    if (interaction.response?.count !== undefined) {
        return waitForWsMessageCount({ interaction, config, context, details, observeCloseEvents: true });
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
        toWsFailureStatus(
            config,
            interaction,
            'WebSocket wait expects expect.message, expect.messages, expect.count, expect.absent, or expect.close'
        )
    );
}

async function waitRemoteWs(
    interaction: WsInteraction,
    config: unknown,
    context: RemoteWsContext
): Promise<WsInteractionResult> {
    const remote = readRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    return await waitWithRemoteWsEventSync({ remote, fetchFn, context, interaction, config });
}

async function closeRemoteWs(
    interaction: WsInteraction,
    config: unknown,
    context: RemoteWsContext
): Promise<WsInteractionResult> {
    const connectionName = toWsConnectionName(interaction.request);
    const remote = readRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    const commandId = toRallarRemoteBrowserCommandId('ws-close', interaction);
    const command = toRemoteWsCloseCommand(commandId, interaction);

    try {
        const result = await executeRallarRemoteBrowserCommand({
            remote: remote,
            fetchFn: fetchFn,
            context: context,
            command: command
        });
        await syncRallarRemoteBrowserEvents(remote, fetchFn, context);
        invalidateRemoteWsObservations(connectionName, context);
        delete context.wsConnections[connectionName];

        if (!result.ok) {
            return toWsFailureStatus(config, interaction, 'Remote WebSocket close failed', {
                connection: connectionName,
                remote,
                result
            });
        }

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
        return toWsFailureStatus(config, interaction, 'Remote WebSocket close failed', {
            connection: connectionName,
            remote,
            exception: error instanceof Error ? error.message : String(error)
        });
    }
}

export function executeRemoteWsInteraction(
    interaction: WsInteraction,
    config: unknown,
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

    return Promise.resolve(toWsFailureStatus(config, interaction, 'Unsupported WebSocket action: ' + action, {}));
}
