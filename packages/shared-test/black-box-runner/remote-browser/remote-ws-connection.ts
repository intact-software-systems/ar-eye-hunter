import { Either } from '../../../shared/resilience/Either.ts';

import type {
    RallarBlackBoxTestWsCloseCommand,
    RallarBlackBoxTestWsOpenCommand,
    RallarBlackBoxTestWsSendCommand
} from '../../rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { BlackBoxFetch } from '../execution/black-box-scenario-context.ts';
import {
    getRemoteBrowserRunnerOptions,
    validateRemoteDestination,
    validateRemotePayloadSize
} from '../execution/remote-browser-execution.ts';
import type { WsInteractionConfig } from '../ws/ws-interaction-statuses.ts';
import { toWsConnectionName } from '../ws/ws-interaction-statuses.ts';
import type {
    WsInteraction,
    WsInteractionRequest,
    WsWaitContext
} from '../ws/ws-wait-expectations.ts';
import { runRallarRemoteBrowserCommand } from './rallar-remote-browser-control-client.ts';
import {
    resolveRallarRemoteBrowserConfig,
    type RallarRemoteBrowserConfig
} from './resolve-rallar-remote-browser-config.ts';

export interface RemoteWsContext extends WsWaitContext {
    readonly wsConnections: Record<string, RemoteWsConnection | WebSocket | undefined>;
    readonly wsCloseEvents: NonNullable<WsWaitContext['wsCloseEvents']>;
}

export namespace RemoteWsConnection {
    export interface Input {
        readonly url: string;
        readonly commandId: string;
        readonly remote: RallarRemoteBrowserConfig;
        readonly fetch: BlackBoxFetch;
        readonly context: RemoteWsContext;
        readonly interaction: WsInteraction;
    }
}

/** A WebSocket the browser agent holds open; the runner's cleanup closes it through the control server. */
export class RemoteWsConnection {
    readonly remote = true;
    readonly readyState = 1;
    readonly url: string;
    readonly #input: RemoteWsConnection.Input;

    constructor(input: RemoteWsConnection.Input) {
        this.#input = input;
        this.url = input.url;
    }

    async close(code?: number, reason?: string): Promise<void> {
        const { remote, fetch, context, interaction, commandId } = this.#input;
        resetRemoteWsObservations(toWsConnectionName(interaction.request), context);
        const closed = await runRallarRemoteBrowserCommand({
            remote,
            fetch,
            context,
            command: { ...toRemoteWsCloseCommand(`${commandId}-auto-close`, interaction), code, reason }
        });
        const failure = closed.fold(
            (error) => error,
            (result) => result.ok ? undefined : new Error(result.error?.message ?? 'Remote WebSocket close failed')
        );
        if (failure !== undefined) {
            // The runner's connection cleanup port reports a refused close by rejecting.
            throw failure;
        }
    }
}

export function resolveRemoteWsConfig(
    interaction: WsInteraction,
    config: WsInteractionConfig,
    context: RemoteWsContext
): RallarRemoteBrowserConfig {
    return resolveRallarRemoteBrowserConfig({
        request: interaction.request,
        config,
        context,
        options: getRemoteBrowserRunnerOptions(context)
    });
}

export function toWsUrl(request: WsInteractionRequest): string | undefined {
    return request.url || request.path;
}

export function toRemoteWsPayload(request: WsInteractionRequest): RallarBlackBoxTestWsSendCommand['data'] {
    return request.send !== undefined
        ? request.send
        : request.message !== undefined
        ? request.message
        : request.body;
}

export function toRemoteWsOpenCommand(
    commandId: string,
    interaction: WsInteraction,
    context: RemoteWsContext
): Either<Error, RallarBlackBoxTestWsOpenCommand> {
    const request = interaction.request;
    const url = toWsUrl(request);
    const [issue] = validateRemoteDestination({ request, context, url, label: 'WebSocket' });
    return issue !== undefined
        ? Either.ofLeft(new Error(issue))
        : Either.ofRight({
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
        });
}

export function toRemoteWsSendCommand(
    commandId: string,
    interaction: WsInteraction,
    context: RemoteWsContext
): Either<Error, RallarBlackBoxTestWsSendCommand> {
    const request = interaction.request;
    const payload = toRemoteWsPayload(request);
    const [issue] = validateRemotePayloadSize({ request, context, value: payload, label: 'WebSocket send' });
    return issue !== undefined
        ? Either.ofLeft(new Error(issue))
        : Either.ofRight({
            kind: 'ws.send',
            commandId,
            connection: toWsConnectionName(request),
            data: payload,
            timeoutMs: request.timeoutMs === undefined ? undefined : Number(request.timeoutMs),
            metadata: {
                blackBoxRunner: request
            }
        });
}

export function toRemoteWsCloseCommand(
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

/** Clears the connection's observed messages and counts the loss, so no wait window spanning it can pass. */
export function resetRemoteWsObservations(connectionName: string, context: RemoteWsContext): void {
    const losses = context.wsObservationLoss ??= {};
    losses[connectionName] = (losses[connectionName] ?? 0) + 1;
    context.wsMessages[connectionName] = [];
}
