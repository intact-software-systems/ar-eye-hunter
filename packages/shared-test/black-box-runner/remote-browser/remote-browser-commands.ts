import type { ApiJsonValue } from '../../../shared/api/api-json-value.ts';
import { Either } from '../../../shared/resilience/Either.ts';

import type { RallarBlackBoxTestCommand } from '../../rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../rallar-bb-test/schema/json-schema-validation.ts';
import { toRtcPayload } from '../rtc-provider.ts';
import { decodeScenarioText } from '../scenario-value-decoding.ts';
import {
    decodeRemoteBrowserCommand,
    toRemoteBrowserConnectionName,
    type RemoteBrowserCommandInteraction
} from './decode-remote-browser-command.ts';
import { toCrdtCommand } from './to-crdt-command.ts';
import { toRallarScopeFields } from './to-rallar-scope-fields.ts';

export type RemoteBrowserCommandAction = 'connect' | 'send' | 'close' | 'health' | 'crdt';

/** The step fields a command id is built from; a field the step does not set takes no part in the id. */
export interface RemoteBrowserCommandIdentitySource {
    readonly request: Readonly<Partial<Record<RemoteBrowserCommandIdentityField, ApiJsonValue>>>;
}

export interface IdentifiedRemoteBrowserCommand {
    readonly commandId: string;
    readonly connectionName: string;
    readonly command: RallarBlackBoxTestCommand;
}

export interface IdentifiedRemoteBrowserConnection extends IdentifiedRemoteBrowserCommand {
    readonly closeCommand: RallarBlackBoxTestCommand;
}

const COMMAND_ID_PARTS = [
    ['scenarioExecutionNumber', 's'],
    ['interactionExecutionNumber', 'i'],
    ['repeatIndex', 'r'],
    ['connection', ''],
    ['actor', '']
] as const;

type RemoteBrowserCommandIdentityField = typeof COMMAND_ID_PARTS[number][0] | 'commandId';

/** A connect also translates the close the runner sends when the run ends with the connection still open. */
export function toRemoteBrowserConnection(
    interaction: RemoteBrowserCommandInteraction
): Either<Error, IdentifiedRemoteBrowserConnection> {
    return toRemoteBrowserCommand('connect', interaction).flatMap(
        (error) => Either.ofLeft(error),
        (connection) =>
            toCloseCommand(`${connection.commandId}-auto-close`, interaction)
                .mapRight((closeCommand) => ({ ...connection, closeCommand }))
    );
}

export function toRemoteBrowserCommand(
    action: RemoteBrowserCommandAction,
    interaction: RemoteBrowserCommandInteraction
): Either<Error, IdentifiedRemoteBrowserCommand> {
    const crdtAction = interaction.request.action === undefined ? 'open' : interaction.request.action;
    if (action === 'crdt' && typeof crdtAction !== 'string') {
        return Either.ofLeft(new Error('CRDT action must be a string.'));
    }
    const identity = toRallarRemoteBrowserCommandId(action === 'crdt' ? `crdt-${crdtAction}` : action, interaction);
    const connectionName = toRemoteBrowserConnectionName(interaction.request);
    const address = identity.flatMap(
        (error) => Either.ofLeft<Error, Omit<IdentifiedRemoteBrowserCommand, 'command'>>(error),
        (commandId) => connectionName.mapRight((name) => ({ commandId, connectionName: name }))
    );
    return address.flatMap(
        (error) => Either.ofLeft(error),
        (identified) =>
            toActionCommand(action, identified.commandId, interaction).mapRight((command) => ({
                ...identified,
                command
            }))
    );
}

/** An explicit commandId wins; otherwise the id is built from the step's execution position. */
export function toRallarRemoteBrowserCommandId(
    action: string,
    interaction: RemoteBrowserCommandIdentitySource
): Either<Error, string> {
    const request = interaction.request;
    if (typeof request.commandId === 'string' && request.commandId.trim().length > 0) {
        return Either.ofRight(request.commandId.trim());
    }
    const parts = ['rallar-remote-browser', action];
    for (const [key, prefix] of COMMAND_ID_PARTS) {
        const value = request[key];
        if (value === undefined || (prefix === '' && (value === null || value === ''))) {
            continue;
        }
        const text = decodeScenarioText(value);
        if (text === undefined) {
            return Either.ofLeft(new Error(`Remote command ${key} must be a scalar identifier.`));
        }
        parts.push(prefix + text);
    }
    return Either.ofRight(parts.join('-'));
}

export function toConnectCommand(
    commandId: string,
    interaction: RemoteBrowserCommandInteraction
): Either<Error, RallarBlackBoxTestCommand> {
    const request = interaction.request;
    const scope = toRallarScopeFields(request);
    const connection = toRemoteBrowserConnectionName(request);
    if (scope.right === undefined || connection.right === undefined) {
        return Either.ofLeft(scope.left ?? connection.left ?? new Error('Invalid remote command scope.'));
    }
    if (request.actor !== undefined && decodeScenarioText(request.actor) === undefined) {
        return Either.ofLeft(new Error('Remote command actor must be a scalar identifier.'));
    }
    return decodeRemoteBrowserCommand({
        kind: 'rtc.connect',
        commandId,
        connection: connection.right,
        actor: request.actor === undefined ? undefined : decodeScenarioText(request.actor),
        roomId: request.roomId === undefined ? undefined : decodeScenarioText(request.roomId),
        ...scope.right,
        transport: request.transport,
        readiness: request.readiness,
        rallar: {
            ...(isJsonRecordValue(request.rallar) ? request.rallar : {}),
            ...scope.right
        },
        timeoutMs: request.timeoutMs,
        metadata: {
            ...(request.parity ? { parity: request.parity } : {}),
            blackBoxRunner: request
        }
    });
}

export function toSendCommand(
    commandId: string,
    interaction: RemoteBrowserCommandInteraction
): Either<Error, RallarBlackBoxTestCommand> {
    const request = interaction.request;
    const scope = toRallarScopeFields(request);
    const connection = toRemoteBrowserConnectionName(request);
    if (scope.right === undefined || connection.right === undefined) {
        return Either.ofLeft(scope.left ?? connection.left ?? new Error('Invalid remote command scope.'));
    }
    const scopeFields = scope.right;
    const payload = toRtcPayload(request);
    const send = isJsonRecordValue(payload)
        ? { ...payload, ...Object.fromEntries(Object.entries(scopeFields).filter(([key]) => !(key in payload))) }
        : { data: payload, ...scopeFields };
    return decodeRemoteBrowserCommand({
        kind: 'rtc.send',
        commandId,
        connection: connection.right,
        send,
        ...scopeFields,
        transport: request.transport,
        timeoutMs: request.timeoutMs,
        metadata: {
            ...(request.parity ? { parity: request.parity } : {}),
            blackBoxRunner: request
        }
    });
}

export function toCloseCommand(
    commandId: string,
    interaction: RemoteBrowserCommandInteraction
): Either<Error, RallarBlackBoxTestCommand> {
    const request = interaction.request;
    return toRemoteBrowserConnectionName(request).flatMap(
        (error) => Either.ofLeft(error),
        (connection) =>
            decodeRemoteBrowserCommand({
                kind: 'close',
                commandId,
                timeoutMs: request.timeoutMs,
                metadata: {
                    ...(request.parity ? { parity: request.parity } : {}),
                    connection,
                    blackBoxRunner: request
                }
            })
    );
}

export function toHealthCommand(
    commandId: string,
    interaction: RemoteBrowserCommandInteraction
): Either<Error, RallarBlackBoxTestCommand> {
    const request = interaction.request;
    return toRemoteBrowserConnectionName(request).flatMap(
        (error) => Either.ofLeft(error),
        (connection) =>
            decodeRemoteBrowserCommand({
                kind: 'health',
                commandId,
                timeoutMs: request.timeoutMs,
                metadata: {
                    connection,
                    blackBoxRunner: request
                }
            })
    );
}

function toActionCommand(
    action: RemoteBrowserCommandAction,
    commandId: string,
    interaction: RemoteBrowserCommandInteraction
): Either<Error, RallarBlackBoxTestCommand> {
    switch (action) {
        case 'connect':
            return toConnectCommand(commandId, interaction);
        case 'send':
            return toSendCommand(commandId, interaction);
        case 'close':
            return toCloseCommand(commandId, interaction);
        case 'health':
            return toHealthCommand(commandId, interaction);
        case 'crdt':
            return toCrdtCommand(commandId, interaction);
    }
}
