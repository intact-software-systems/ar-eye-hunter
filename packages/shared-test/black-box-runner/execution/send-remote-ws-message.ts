// deno-lint-ignore-file no-explicit-any
import { Either } from '../../../shared/resilience/Either.ts';

import type { ControlResultEnvelope } from '../../rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestWsSendCommand } from '../../rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    runRallarRemoteBrowserCommand,
    syncRallarRemoteBrowserEvents
} from '../remote-browser/rallar-remote-browser-control-client.ts';
import { toRallarRemoteBrowserCommandId } from '../remote-browser/remote-browser-commands.ts';
import type { RallarRemoteBrowserConfig } from '../remote-browser/resolve-rallar-remote-browser-config.ts';
import type { WsInteractionConfig } from '../ws/ws-interaction-statuses.ts';
import {
    toWsConnectionName,
    toWsFailureStatus,
    toWsSuccessStatus
} from '../ws/ws-interaction-statuses.ts';
import type {
    WsInteraction,
    WsInteractionResult
} from '../ws/ws-wait-expectations.ts';
import type { BlackBoxFetch } from './black-box-scenario-context.ts';
import {
    resolveRemoteBrowserFetch,
    toRemoteResultValue
} from './remote-browser-execution.ts';
import {
    resolveRemoteWsConfig,
    toRemoteWsPayload,
    toRemoteWsSendCommand,
    type RemoteWsContext
} from './remote-ws-connection.ts';
import { waitWithRemoteWsEventSync } from './wait-with-remote-ws-event-sync.ts';

interface RemoteWsSendTarget {
    readonly interaction: WsInteraction;
    readonly config: WsInteractionConfig;
    readonly context: RemoteWsContext;
    readonly connectionName: string;
    readonly remote: RallarRemoteBrowserConfig;
    readonly fetch: BlackBoxFetch;
}

interface RemoteWsSendInput extends RemoteWsSendTarget {
    readonly commandId: string;
}

interface RemoteWsSendObservation {
    readonly sent: RallarBlackBoxTestWsSendCommand['data'];
    readonly result: ControlResultEnvelope;
    readonly sendStartedAtEpochMs: number;
    readonly sendEndedAtEpochMs: number;
}

interface RemoteWsSendDetails {
    readonly sentConnection: string;
    readonly sent: RallarBlackBoxTestWsSendCommand['data'];
    readonly remote: RallarRemoteBrowserConfig;
    readonly commandId: string;
    readonly result: any;
    readonly sendResult: {
        readonly status: 'sent' | 'failed';
        readonly connection: string;
        readonly remoteResult: any;
    };
    readonly sendStartedAtEpochMs: number;
    readonly sendEndedAtEpochMs: number;
    readonly sendLatencyMs: number;
}

export function sendRemoteWsMessage(
    interaction: WsInteraction,
    config: WsInteractionConfig,
    context: RemoteWsContext
): Promise<WsInteractionResult> {
    const connectionName = toWsConnectionName(interaction.request);
    if (!context.wsConnections[connectionName]) {
        return Promise.resolve(toWsFailureStatus({
            config,
            interaction,
            result: 'WebSocket connection is not open',
            details: { connection: connectionName }
        }));
    }
    const remote = resolveRemoteWsConfig(interaction, config, context);
    const target = { interaction, config, context, connectionName, remote, fetch: resolveRemoteBrowserFetch(context) };
    return toRallarRemoteBrowserCommandId('ws-send', interaction).fold(
        (error) => Promise.resolve(toRemoteWsSendFailure(target, error)),
        (commandId) => sendIdentifiedRemoteWsMessage({ ...target, commandId })
    );
}

async function sendIdentifiedRemoteWsMessage(input: RemoteWsSendInput): Promise<WsInteractionResult> {
    const sent = await writeRemoteWsMessage(input);
    return sent.fold(
        (error) => Promise.resolve(toRemoteWsSendFailure(input, error)),
        (observation) => observeRemoteWsSend(input, observation)
    );
}

function writeRemoteWsMessage(input: RemoteWsSendInput): Promise<Either<Error, RemoteWsSendObservation>> {
    const { interaction, context, remote, fetch, commandId } = input;
    return toRemoteWsSendCommand(commandId, interaction, context).fold(
        (error) => Promise.resolve(Either.ofLeft(error)),
        async (command) => {
            const sendStartedAtEpochMs = context.dependencies.now();
            const ran = await runRallarRemoteBrowserCommand({ remote, fetch, context, command });
            const sendEndedAtEpochMs = context.dependencies.now();
            return ran.mapRight((result) => ({ sent: command.data, result, sendStartedAtEpochMs, sendEndedAtEpochMs }));
        }
    );
}

async function observeRemoteWsSend(
    input: RemoteWsSendInput,
    observation: RemoteWsSendObservation
): Promise<WsInteractionResult> {
    const { interaction, config, context, connectionName, remote, fetch } = input;
    const details = toRemoteWsSendDetails(input, observation);
    if (!observation.result.ok) {
        return toWsFailureStatus({
            config,
            interaction,
            result: 'Remote WebSocket send failed',
            details: { ...details, connection: connectionName, result: observation.result }
        });
    }
    const response = interaction.response;
    if (response?.count !== undefined || response?.messages || response?.message) {
        return waitWithRemoteWsEventSync({ remote, fetch, context, interaction, config, details: { ...details } });
    }
    const synced = await syncRallarRemoteBrowserEvents(remote, fetch, context);
    return synced.fold(
        (error) => toRemoteWsSendFailure(input, error),
        () => toWsSuccessStatus(config, interaction, { ...details, connection: connectionName })
    );
}

function toRemoteWsSendDetails(input: RemoteWsSendInput, observation: RemoteWsSendObservation): RemoteWsSendDetails {
    const remoteResult = toRemoteResultValue(observation.result);
    return {
        sentConnection: toWsConnectionName(input.interaction.request),
        sent: observation.sent,
        remote: input.remote,
        commandId: input.commandId,
        result: remoteResult,
        sendResult: {
            status: observation.result.ok ? 'sent' : 'failed',
            connection: toWsConnectionName(input.interaction.request),
            remoteResult
        },
        sendStartedAtEpochMs: observation.sendStartedAtEpochMs,
        sendEndedAtEpochMs: observation.sendEndedAtEpochMs,
        sendLatencyMs: observation.sendEndedAtEpochMs - observation.sendStartedAtEpochMs
    };
}

function toRemoteWsSendFailure(target: RemoteWsSendTarget, error: Error): WsInteractionResult {
    const { interaction, config, remote, connectionName } = target;
    return toWsFailureStatus({
        config,
        interaction,
        result: 'Remote WebSocket send failed',
        details: {
            connection: connectionName,
            remote,
            sent: toRemoteWsPayload(interaction.request),
            sendResult: { status: 'failed', connection: connectionName, exception: error.message },
            exception: error.message
        }
    });
}
