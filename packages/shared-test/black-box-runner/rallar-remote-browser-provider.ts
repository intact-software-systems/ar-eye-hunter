// deno-lint-ignore-file no-explicit-any
import type { BlackBoxFetch } from './execution/black-box-scenario-context.ts';
import {
    runRallarRemoteBrowserCommand,
    toRemoteResultDetails,
    type RunRallarRemoteBrowserCommandInput
} from './remote-browser/rallar-remote-browser-control-client.ts';
import {
    toRemoteBrowserCommand,
    toRemoteBrowserConnection,
    type IdentifiedRemoteBrowserCommand,
    type IdentifiedRemoteBrowserConnection
} from './remote-browser/remote-browser-commands.ts';
import { runWithRemoteBrowserEventSync } from './remote-browser/remote-browser-observation-sync.ts';
import {
    toRemoteCrdtFailureStatus,
    toRemoteCrdtStatus
} from './remote-browser/remote-crdt-statuses.ts';
import {
    computeRemoteRtcConnectedState,
    toRemoteRtcCloseStatus,
    toRemoteRtcConnectFailure,
    toRemoteRtcFailure,
    toRemoteRtcSendDetails,
    toRemoteRtcSendFailure,
    type RemoteRtcConnectCompletion,
    type RemoteRtcSendSubmission
} from './remote-browser/remote-rtc-statuses.ts';
import {
    resolveRallarRemoteBrowserConfig,
    type RallarRemoteBrowserConfig,
    type RallarRemoteBrowserOptions
} from './remote-browser/resolve-rallar-remote-browser-config.ts';
import {
    toRemoteRtcExpectation,
    waitForRemoteRtcHealth,
    waitForRemoteRtcObservation
} from './remote-browser/wait-for-remote-rtc-observation.ts';
import type { RtcProvider } from './rtc-provider.ts';
import {
    rememberRtcCloseEvent,
    toRtcFailureStatus,
    toRtcSuccessStatus
} from './rtc/rtc-wait-expectations.ts';

export interface CreateRallarRemoteBrowserRtcProviderInput extends RallarRemoteBrowserOptions {
    readonly fetch: BlackBoxFetch;
}

interface RemoteRtcOperation {
    readonly provider: CreateRallarRemoteBrowserRtcProviderInput;
    readonly interaction: any;
    readonly config: any;
    readonly context: any;
}

interface RemoteRtcConnectAcceptance {
    readonly operation: RemoteRtcOperation;
    readonly closeCommand: RunRallarRemoteBrowserCommandInput;
    readonly completion: RemoteRtcConnectCompletion;
}

export function createRallarRemoteBrowserRtcProvider(input: CreateRallarRemoteBrowserRtcProviderInput): RtcProvider {
    return {
        connect: (interaction, config, context) => connectRemoteRtc({ provider: input, interaction, config, context }),
        send: (interaction, config, context) => sendRemoteRtc({ provider: input, interaction, config, context }),
        wait: (interaction, config, context) => waitRemoteRtc({ provider: input, interaction, config, context }),
        command: (interaction, config, context) =>
            runRemoteCrdtCommand({ provider: input, interaction, config, context }),
        close: (interaction, config, context) => closeRemoteRtc({ provider: input, interaction, config, context })
    };
}

function connectRemoteRtc(operation: RemoteRtcOperation): Promise<any> {
    const { interaction, config } = operation;
    return toRemoteBrowserConnection(interaction).fold(
        (error) =>
            Promise.resolve(toRemoteRtcFailure({ config, interaction, message: 'Remote RTC connect failed', error })),
        (connection) => connectIdentifiedRemoteRtc(operation, connection)
    );
}

async function connectIdentifiedRemoteRtc(
    operation: RemoteRtcOperation,
    connection: IdentifiedRemoteBrowserConnection
): Promise<any> {
    const { provider, interaction, config, context } = operation;
    const remote = resolveOperationConfig(operation);
    const connectStartedAtEpochMs = context.dependencies.now();
    const connected = await runRallarRemoteBrowserCommand({
        remote,
        fetch: provider.fetch,
        context,
        command: connection.command
    });
    const connectedAtEpochMs = context.dependencies.now();
    return connected.fold(
        (error) => toRemoteRtcFailure({ config, interaction, message: 'Remote RTC connect failed', error }),
        (result) => {
            const { commandId, connectionName } = connection;
            const completion = {
                remote,
                commandId,
                connectionName,
                result,
                connectStartedAtEpochMs,
                connectedAtEpochMs
            };
            const closeCommand = { remote, fetch: provider.fetch, context, command: connection.closeCommand };
            return result.ok
                ? recordRemoteRtcConnection({ operation, closeCommand, completion })
                : toRemoteRtcConnectFailure(config, interaction, completion);
        }
    );
}

function recordRemoteRtcConnection(acceptance: RemoteRtcConnectAcceptance): any {
    const { operation, closeCommand, completion } = acceptance;
    const { interaction, config, context } = operation;
    const connected = computeRemoteRtcConnectedState(interaction, completion);
    const connectionName = completion.connectionName;
    context.rtcConnections[connectionName] = { client: new RemoteRtcConnection(closeCommand), ...connected.connection };
    context.rtcMessages[connectionName] ||= [];
    context.rtcDiagnostics ||= {};
    context.rtcDiagnostics[connectionName] ||= [];
    context.rtcCloseEvents[connectionName] ||= [];
    return toRtcSuccessStatus(config, interaction, connected.details);
}

function sendRemoteRtc(operation: RemoteRtcOperation): Promise<any> {
    const { interaction, config, context } = operation;
    return toRemoteBrowserCommand('send', interaction).fold(
        (error) =>
            Promise.resolve(toRemoteRtcFailure({ config, interaction, message: 'Remote RTC send failed', error })),
        (send) =>
            context.rtcConnections[send.connectionName]
                ? sendIdentifiedRemoteRtc(operation, send)
                : Promise.resolve(toRtcFailureStatus({
                    config,
                    interaction,
                    result: 'RTC connection is not open',
                    details: { connection: send.connectionName }
                }))
    );
}

async function sendIdentifiedRemoteRtc(
    operation: RemoteRtcOperation,
    send: IdentifiedRemoteBrowserCommand
): Promise<any> {
    const { provider, interaction, config, context } = operation;
    const remote = resolveOperationConfig(operation);
    const sendStartedAtEpochMs = context.dependencies.now();
    const sent = await runRallarRemoteBrowserCommand({ remote, fetch: provider.fetch, context, command: send.command });
    const sendEndedAtEpochMs = context.dependencies.now();
    return sent.fold(
        (error) =>
            Promise.resolve(toRemoteRtcFailure({ config, interaction, message: 'Remote RTC send failed', error })),
        (result) =>
            observeRemoteRtcSend(operation, {
                remote,
                command: send.command,
                result,
                connectionName: send.connectionName,
                sendStartedAtEpochMs,
                sendEndedAtEpochMs
            })
    );
}

async function observeRemoteRtcSend(operation: RemoteRtcOperation, submission: RemoteRtcSendSubmission): Promise<any> {
    const { provider, interaction, config, context } = operation;
    if (!submission.result.ok) {
        return toRemoteRtcSendFailure(config, interaction, submission);
    }
    const details = toRemoteRtcSendDetails(interaction, submission);
    const expectation = toRemoteRtcExpectation(interaction.response, 'send');
    if (expectation === 'none') {
        return toRtcSuccessStatus(config, interaction, details);
    }
    const waitInput = { remote: submission.remote, fetch: provider.fetch, context, interaction, config, details };
    const observed = await waitForRemoteRtcObservation(waitInput, expectation);
    return observed.fold(
        (error) => toRemoteRtcFailure({ config, interaction, message: 'Remote RTC send failed', error }),
        (status) => status
    );
}

async function waitRemoteRtc(operation: RemoteRtcOperation): Promise<any> {
    const { provider, interaction, config, context } = operation;
    const remote = resolveOperationConfig(operation);
    const waitInput = { remote, fetch: provider.fetch, context, interaction, config, details: { remote } };
    const expectation = toRemoteRtcExpectation(interaction.response, 'wait');
    const observed = expectation === 'health'
        ? await runWithRemoteBrowserEventSync(waitInput, () => waitForRemoteRtcHealth(waitInput))
        : await waitForRemoteRtcObservation(waitInput, expectation);
    return observed.fold(
        (error) => toRemoteRtcFailure({ config, interaction, message: 'Remote RTC wait failed', error }),
        (status) => status
    );
}

function runRemoteCrdtCommand(operation: RemoteRtcOperation): Promise<any> {
    const { interaction, config } = operation;
    return toRemoteBrowserCommand('crdt', interaction).fold(
        (error) =>
            Promise.resolve(toRemoteCrdtFailureStatus({ config, interaction, details: { error: error.message } })),
        (crdt) => runIdentifiedRemoteCrdtCommand(operation, crdt)
    );
}

async function runIdentifiedRemoteCrdtCommand(
    operation: RemoteRtcOperation,
    crdt: IdentifiedRemoteBrowserCommand
): Promise<any> {
    const { provider, interaction, config, context } = operation;
    const { commandId, command } = crdt;
    const remote = resolveOperationConfig(operation);
    const startedAtEpochMs = context.dependencies.now();
    const ran = await runRallarRemoteBrowserCommand({ remote, fetch: provider.fetch, context, command });
    const endedAtEpochMs = context.dependencies.now();
    return ran.fold(
        (error) =>
            toRemoteCrdtFailureStatus({ config, interaction, details: { remote, commandId, error: error.message } }),
        (result) =>
            toRemoteCrdtStatus(config, interaction, { remote, commandId, result, startedAtEpochMs, endedAtEpochMs })
    );
}

function closeRemoteRtc(operation: RemoteRtcOperation): Promise<any> {
    const { interaction, config } = operation;
    return toRemoteBrowserCommand('close', interaction).fold(
        (error) =>
            Promise.resolve(toRemoteRtcFailure({ config, interaction, message: 'Remote RTC close failed', error })),
        (close) => closeIdentifiedRemoteRtc(operation, close)
    );
}

async function closeIdentifiedRemoteRtc(
    operation: RemoteRtcOperation,
    close: IdentifiedRemoteBrowserCommand
): Promise<any> {
    const { provider, interaction, config, context } = operation;
    const { commandId, command, connectionName } = close;
    const remote = resolveOperationConfig(operation);
    const closed = await runRallarRemoteBrowserCommand({ remote, fetch: provider.fetch, context, command });
    return closed.fold(
        (error) => toRemoteRtcFailure({ config, interaction, message: 'Remote RTC close failed', error }),
        (result) => {
            if (result.ok) {
                delete context.rtcConnections[connectionName];
            }
            rememberRtcCloseEvent(connectionName, {
                closeRequested: true,
                closed: result.ok,
                closedAtEpochMs: context.dependencies.now(),
                provider: interaction.request.provider,
                remote,
                commandId,
                result: toRemoteResultDetails(result)
            }, context);
            return toRemoteRtcCloseStatus(config, interaction, { remote, commandId, connectionName, result });
        }
    );
}

function resolveOperationConfig(operation: RemoteRtcOperation): RallarRemoteBrowserConfig {
    const { provider, interaction, config, context } = operation;
    return resolveRallarRemoteBrowserConfig({ request: interaction.request, config, context, options: provider });
}

class RemoteRtcConnection {
    private readonly closeCommand: RunRallarRemoteBrowserCommandInput;

    constructor(closeCommand: RunRallarRemoteBrowserCommandInput) {
        this.closeCommand = closeCommand;
    }

    async close(): Promise<void> {
        const closed = await runRallarRemoteBrowserCommand(this.closeCommand);
        const failure = closed.fold(
            (error) => error,
            (result) => result.ok ? undefined : new Error(result.error?.message ?? 'Remote RTC close failed')
        );
        if (failure !== undefined) {
            // The runner's connection cleanup port reports a refused close by rejecting.
            throw failure;
        }
    }
}
