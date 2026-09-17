import { Either } from '../../../shared/resilience/Either.ts';

import type { ControlResultEnvelope } from '../../rallar-bb-test/control-protocol.ts';
import {
    runRallarRemoteBrowserCommand,
    syncRallarRemoteBrowserEvents
} from '../remote-browser/rallar-remote-browser-control-client.ts';
import { toRallarRemoteBrowserCommandId } from '../remote-browser/remote-browser-commands.ts';
import type { WsInteractionConfig } from '../ws/ws-interaction-statuses.ts';
import {
    toWsConnectionName,
    toWsExpectedConnectionName,
    toWsFailureStatus,
    toWsSuccessStatus
} from '../ws/ws-interaction-statuses.ts';
import type {
    WsInteraction,
    WsInteractionResult
} from '../ws/ws-wait-expectations.ts';
import {
    isRallarRemoteBrowserRequest,
    resolveRemoteBrowserFetch,
    toRemoteResultValue
} from './remote-browser-execution.ts';
import {
    RemoteWsConnection,
    resetRemoteWsObservations,
    resolveRemoteWsConfig,
    toRemoteWsCloseCommand,
    toRemoteWsOpenCommand,
    toWsUrl,
    type RemoteWsContext
} from './remote-ws-connection.ts';
import { sendRemoteWsMessage } from './send-remote-ws-message.ts';
import { waitWithRemoteWsEventSync } from './wait-with-remote-ws-event-sync.ts';

interface RemoteWsCommandInput extends Omit<RemoteWsConnection.Input, 'url'> {
    readonly config: WsInteractionConfig;
}

interface RemoteWsOpenInput extends RemoteWsConnection.Input {
    readonly config: WsInteractionConfig;
}

interface RemoteWsCommandCompletion<Input> {
    readonly input: Input;
    readonly result: ControlResultEnvelope;
}

export function runRemoteWsInteraction(
    interaction: WsInteraction,
    config: WsInteractionConfig,
    context: RemoteWsContext
): Promise<WsInteractionResult> {
    const action = interaction.request.action || 'send';

    if (action === 'connect' || action === 'open') {
        return openRemoteWs(interaction, config, context);
    }

    if (action === 'send') {
        return sendRemoteWsMessage(interaction, config, context);
    }

    if (action === 'wait' || action === 'expect') {
        const remote = resolveRemoteWsConfig(interaction, config, context);
        const fetch = resolveRemoteBrowserFetch(context);
        return waitWithRemoteWsEventSync({ remote, fetch, context, interaction, config, details: { remote } });
    }

    if (action === 'close') {
        return closeRemoteWs(interaction, config, context);
    }

    return Promise.resolve(
        toWsFailureStatus({ config, interaction, result: 'Unsupported WebSocket action: ' + action, details: {} })
    );
}

/** A step runs in the remote browser when it asks for it or when its connection was opened there. */
export function isRemoteWsInteraction(interaction: WsInteraction, context: RemoteWsContext): boolean {
    const action = interaction.request.action || 'send';
    const connectionName = action === 'wait' || action === 'expect'
        ? toWsExpectedConnectionName(interaction)
        : toWsConnectionName(interaction.request);
    const connection = context.wsConnections[connectionName];
    return isRallarRemoteBrowserRequest(interaction.request) ||
        (connection !== undefined && 'remote' in connection && connection.remote);
}

function openRemoteWs(
    interaction: WsInteraction,
    config: WsInteractionConfig,
    context: RemoteWsContext
): Promise<WsInteractionResult> {
    const url = toWsUrl(interaction.request);
    if (!url) {
        return Promise.resolve(
            toWsFailureStatus({ config, interaction, result: 'WebSocket URL is missing', details: {} })
        );
    }
    const remote = resolveRemoteWsConfig(interaction, config, context);
    const fetch = resolveRemoteBrowserFetch(context);
    return toRallarRemoteBrowserCommandId('ws-open', interaction).fold(
        (error) =>
            Promise.resolve(toWsFailureStatus({
                config,
                interaction,
                result: 'Remote WebSocket connect failed',
                details: { exception: error.message }
            })),
        (commandId) => openIdentifiedRemoteWs({ interaction, config, context, remote, fetch, commandId, url })
    );
}

async function openIdentifiedRemoteWs(input: RemoteWsOpenInput): Promise<WsInteractionResult> {
    const { interaction, config, context, remote, fetch, commandId } = input;
    const opened = await toRemoteWsOpenCommand(commandId, interaction, context).fold(
        (error) => Promise.resolve(Either.ofLeft<Error, ControlResultEnvelope>(error)),
        (command) => runRallarRemoteBrowserCommand({ remote, fetch, context, command })
    );
    return opened.fold(
        (error) => toRemoteWsFailure(input, 'Remote WebSocket connect failed', { exception: error.message }),
        (result) => recordRemoteWsConnection({ input, result })
    );
}

function recordRemoteWsConnection(completion: RemoteWsCommandCompletion<RemoteWsOpenInput>): WsInteractionResult {
    const { input, result } = completion;
    const { interaction, config, context, remote, commandId, url } = input;
    const connectionName = toWsConnectionName(interaction.request);
    if (!result.ok) {
        return toRemoteWsFailure(input, 'Remote WebSocket connect failed', { result });
    }
    resetRemoteWsObservations(connectionName, context);
    context.wsConnections[connectionName] = new RemoteWsConnection(input);
    context.wsCloseEvents[connectionName] ??= [];
    return toWsSuccessStatus(config, interaction, {
        connection: connectionName,
        url,
        readyState: 1,
        remote,
        commandId,
        result: toRemoteResultValue(result)
    });
}

function closeRemoteWs(
    interaction: WsInteraction,
    config: WsInteractionConfig,
    context: RemoteWsContext
): Promise<WsInteractionResult> {
    const remote = resolveRemoteWsConfig(interaction, config, context);
    const fetch = resolveRemoteBrowserFetch(context);
    return toRallarRemoteBrowserCommandId('ws-close', interaction).fold(
        (error) =>
            Promise.resolve(toWsFailureStatus({
                config,
                interaction,
                result: 'Remote WebSocket close failed',
                details: { exception: error.message }
            })),
        (commandId) => closeIdentifiedRemoteWs({ interaction, config, context, remote, fetch, commandId })
    );
}

async function closeIdentifiedRemoteWs(input: RemoteWsCommandInput): Promise<WsInteractionResult> {
    const { interaction, context, remote, fetch, commandId } = input;
    const command = toRemoteWsCloseCommand(commandId, interaction);
    const closed = await runRallarRemoteBrowserCommand({ remote, fetch, context, command });
    const synced = await closed.fold(
        (error) => Promise.resolve(Either.ofLeft<Error, ControlResultEnvelope>(error)),
        async (result) => (await syncRallarRemoteBrowserEvents(remote, fetch, context)).mapRight(() => result)
    );
    return synced.fold(
        (error) => toRemoteWsFailure(input, 'Remote WebSocket close failed', { exception: error.message }),
        (result) => recordRemoteWsClose({ input, result })
    );
}

function recordRemoteWsClose(completion: RemoteWsCommandCompletion<RemoteWsCommandInput>): WsInteractionResult {
    const { input, result } = completion;
    const { interaction, config, context, remote, commandId } = input;
    const connectionName = toWsConnectionName(interaction.request);
    if (!result.ok) {
        return toRemoteWsFailure(input, 'Remote WebSocket close failed', { result });
    }
    resetRemoteWsObservations(connectionName, context);
    delete context.wsConnections[connectionName];
    return toWsSuccessStatus(config, interaction, {
        connection: connectionName,
        closeRequested: true,
        closed: true,
        remote,
        commandId,
        result: toRemoteResultValue(result)
    });
}

function toRemoteWsFailure(
    input: RemoteWsCommandInput,
    result: string,
    outcome: Readonly<{ exception: string; }> | Readonly<{ result: ControlResultEnvelope; }>
): WsInteractionResult {
    const { interaction, config, remote } = input;
    return toWsFailureStatus({
        config,
        interaction,
        result,
        details: { connection: toWsConnectionName(interaction.request), remote, ...outcome }
    });
}
