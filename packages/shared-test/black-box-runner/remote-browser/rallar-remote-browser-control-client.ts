// deno-lint-ignore-file no-explicit-any
import type {
    ApiJsonObject,
    ApiJsonValue
} from '../../../shared/api/api-json-value.ts';
import { Either } from '../../../shared/resilience/Either.ts';
import { toError } from '../../../shared/resilience/to-error.ts';

import type { ControlResultEnvelope } from '../../rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestCommand } from '../../rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { BlackBoxFetch } from '../execution/black-box-scenario-context.ts';
import { appendRemoteBrowserEvents } from './append-remote-browser-events.ts';
import {
    decodeRemoteBrowserObservations,
    type RemoteBrowserObservations
} from './decode-remote-browser-observations.ts';
import type { RallarRemoteBrowserConfig } from './resolve-rallar-remote-browser-config.ts';

export interface RunRallarRemoteBrowserCommandInput {
    readonly remote: RallarRemoteBrowserConfig;
    readonly fetch: BlackBoxFetch;
    readonly context: any;
    readonly command: RallarBlackBoxTestCommand;
}

interface RemoteBrowserCommandResultInput extends RunRallarRemoteBrowserCommandInput {
    readonly commandId: string;
}

/** Enqueues the command for the agent, then polls the run until the agent reports its result or the timeout passes. */
export async function runRallarRemoteBrowserCommand(
    input: RunRallarRemoteBrowserCommandInput
): Promise<Either<Error, ControlResultEnvelope>> {
    const { remote, fetch, command } = input;
    const commandId = command.commandId;
    if (commandId === undefined) {
        return Either.ofLeft(new Error(`Remote ${command.kind} command requires a commandId.`));
    }
    const written = await writeRemoteBrowserCommand(remote, fetch, command);
    if (written.left !== undefined) {
        return Either.ofLeft(written.left);
    }
    return readRemoteBrowserCommandResult({ ...input, commandId });
}

/** Reads the run's observations and appends the events this context has not seen yet; nothing is appended on failure. */
export async function syncRallarRemoteBrowserEvents(
    remote: RallarRemoteBrowserConfig,
    fetch: BlackBoxFetch,
    context: any
): Promise<Either<Error, RemoteBrowserObservations>> {
    const observations = await readRemoteBrowserObservations(remote, fetch);
    observations.foldRight((read) => appendRemoteBrowserEvents(read, context));
    return observations;
}

export function toRemoteResultDetails(result: ControlResultEnvelope): any {
    return result.result?.value ?? result.error?.details ?? result.error ?? result.result;
}

async function readRemoteBrowserCommandResult(
    input: RemoteBrowserCommandResultInput
): Promise<Either<Error, ControlResultEnvelope>> {
    const { remote, fetch, context, commandId } = input;
    const startedAt = context.dependencies.now();
    while (context.dependencies.now() - startedAt <= remote.timeoutMs) {
        const synced = await syncRallarRemoteBrowserEvents(remote, fetch, context);
        if (synced.left !== undefined) {
            return Either.ofLeft(synced.left);
        }
        const result = synced.foldRight((observations) =>
            observations.results.find((item) =>
                item.commandId === commandId && item.runId === remote.runId && item.agentId === remote.agentId
            )
        );
        if (result !== undefined) {
            return Either.ofRight(result);
        }
        await new Promise((resolve) => setTimeout(resolve, remote.pollIntervalMs));
    }
    return Either.ofLeft(new Error(`Timed out waiting for remote command result ${commandId}.`));
}

async function writeRemoteBrowserCommand(
    remote: RallarRemoteBrowserConfig,
    fetch: BlackBoxFetch,
    command: RallarBlackBoxTestCommand
): Promise<Either<Error, RallarBlackBoxTestCommand>> {
    const path = `/runs/${encodeURIComponent(remote.runId)}/agents/${encodeURIComponent(remote.agentId)}/commands`;
    try {
        const response = await fetch(toControlUrl(remote, path), {
            method: 'POST',
            signal: AbortSignal.timeout(remote.timeoutMs),
            headers: {
                'Content-Type': 'application/json',
                ...toAuthorizationHeaders(remote)
            },
            body: JSON.stringify({ commandId: command.commandId, command })
        });
        if (!response.ok) {
            const message = await readControlHttpErrorMessage(response);
            return Either.ofLeft(
                new Error(`Control server rejected command ${command.commandId}: ${response.status} ${message}`)
            );
        }
        return Either.ofRight(command);
    }
    catch (caught) {
        return Either.ofLeft(toError(caught));
    }
}

async function readRemoteBrowserObservations(
    remote: RallarRemoteBrowserConfig,
    fetch: BlackBoxFetch
): Promise<Either<Error, RemoteBrowserObservations>> {
    try {
        const response = await fetch(toControlUrl(remote, `/runs/${encodeURIComponent(remote.runId)}`), {
            headers: toAuthorizationHeaders(remote),
            signal: AbortSignal.timeout(remote.timeoutMs)
        });
        if (response.status === 404) {
            // A run the control server does not know yet has recorded no observations.
            return Either.ofRight({ runId: remote.runId, results: [], events: [] });
        }
        if (!response.ok) {
            const message = await readControlHttpErrorMessage(response);
            return Either.ofLeft(new Error(`Control server run lookup failed: ${response.status} ${message}`));
        }
        const snapshot: ApiJsonValue = await response.json();
        return decodeRemoteBrowserObservations(snapshot, remote.runId);
    }
    catch (caught) {
        return Either.ofLeft(toError(caught));
    }
}

async function readControlHttpErrorMessage(response: Response): Promise<string> {
    const body: ApiJsonValue | undefined = await response.json().catch(() => undefined);
    return isApiJsonObject(body) && typeof body.error === 'string'
        ? body.error
        : response.statusText;
}

function toControlUrl(remote: RallarRemoteBrowserConfig, path: string): string {
    return `${remote.controlBaseUrl.replace(/\/+$/, '')}${path}`;
}

function toAuthorizationHeaders(remote: RallarRemoteBrowserConfig): Readonly<Record<string, string>> {
    return remote.token ? { Authorization: `Bearer ${remote.token}` } : {};
}

function isApiJsonObject(value: ApiJsonValue | undefined): value is ApiJsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
