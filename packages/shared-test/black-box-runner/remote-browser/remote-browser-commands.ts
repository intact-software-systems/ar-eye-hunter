import { Either } from '../../../shared/resilience/Either.ts';

import { validateRallarBlackBoxTestCommand } from '../../rallar-bb-test/control-protocol.ts';
import {
    formatJsonSchemaValidationErrors,
    RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
    validateJsonSchema
} from '../../rallar-bb-test/schema.ts';
import type { RallarBlackBoxTestCommand } from '../../rallar-bb-test/types.ts';
import { isRecord } from '../execution/black-box-redaction.ts';
import { toRallarScopeDiagnostics, type RecipeRallarScopeFields } from '../recipes/recipe-rallar-scope.ts';
import { toRtcPayload } from '../rtc-provider.ts';
import { decodeScenarioText } from '../scenario-value-decoding.ts';

export interface RemoteBrowserScopeFields extends RecipeRallarScopeFields {
    readonly minSnapshotVersion?: number;
}

export interface RemoteBrowserCommandInteraction {
    readonly request: Readonly<Record<string, unknown>>;
}

export interface RemoteBrowserCommandIdentityInput {
    readonly request: {
        readonly commandId?: unknown;
        readonly remoteCommandId?: unknown;
        readonly scenarioExecutionNumber?: unknown;
        readonly interactionExecutionNumber?: unknown;
        readonly repeatIndex?: unknown;
        readonly connection?: unknown;
        readonly actor?: unknown;
    };
}

export interface PreparedRemoteBrowserCommand {
    readonly commandId: string;
    readonly connectionName: string;
    readonly command: RallarBlackBoxTestCommand;
}

export interface PreparedRemoteBrowserConnection extends PreparedRemoteBrowserCommand {
    readonly closeCommand: RallarBlackBoxTestCommand;
}

export function prepareRemoteBrowserConnection(
    interaction: RemoteBrowserCommandInteraction
): Either<Error, PreparedRemoteBrowserConnection> {
    const preparation = prepareRemoteBrowserCommand('connect', interaction);
    if (preparation.right === undefined) {
        return Either.ofLeft(preparation.left!);
    }
    const closeCommand = toCloseCommand(`${preparation.right.commandId}-auto-close`, interaction);
    if (closeCommand.right === undefined) {
        return Either.ofLeft(closeCommand.left!);
    }
    return Either.ofRight({ ...preparation.right, closeCommand: closeCommand.right });
}

export function prepareRemoteBrowserCommand(
    action: 'connect' | 'send' | 'close' | 'health' | 'crdt',
    interaction: RemoteBrowserCommandInteraction
): Either<Error, PreparedRemoteBrowserCommand> {
    const crdtAction = interaction.request.action === undefined ? 'open' : interaction.request.action;
    if (action === 'crdt' && typeof crdtAction !== 'string') {
        return Either.ofLeft(new Error('CRDT action must be a string.'));
    }
    const commandId = toRallarRemoteBrowserCommandId(action === 'crdt' ? `crdt-${crdtAction}` : action, interaction);
    const connection = toConnectionName(interaction.request);
    if (commandId.right === undefined || connection.right === undefined) {
        return Either.ofLeft(commandId.left ?? connection.left ?? new Error('Invalid remote command identity.'));
    }
    let command: Either<Error, RallarBlackBoxTestCommand>;
    switch (action) {
        case 'connect':
            command = toConnectCommand(commandId.right, interaction);
            break;
        case 'send':
            command = toSendCommand(commandId.right, interaction);
            break;
        case 'close':
            command = toCloseCommand(commandId.right, interaction);
            break;
        case 'health':
            command = toHealthCommand(commandId.right, interaction);
            break;
        case 'crdt':
            command = toCrdtCommand(commandId.right, interaction);
            break;
    }
    if (command.right === undefined) {
        return Either.ofLeft(command.left!);
    }
    return Either.ofRight({ commandId: commandId.right, connectionName: connection.right, command: command.right });
}

export function toRallarScopeFields(
    request: Readonly<Record<string, unknown>>
): Either<Error, RemoteBrowserScopeFields> {
    if (request.rallar !== undefined && !isRecord(request.rallar)) {
        return Either.ofLeft(new Error('Rallar options must be an object.'));
    }
    const rallar = isRecord(request.rallar) ? request.rallar : {};
    const minSnapshotVersion = request.minSnapshotVersion !== undefined
        ? request.minSnapshotVersion
        : rallar.minSnapshotVersion;
    if (
        minSnapshotVersion !== undefined &&
        (typeof minSnapshotVersion !== 'number' || !Number.isFinite(minSnapshotVersion))
    ) {
        return Either.ofLeft(new Error('minSnapshotVersion must be a finite number.'));
    }
    for (const source of [request, rallar, request.scope, rallar.scope, request.roomRef, rallar.roomRef]) {
        if (source === undefined) {
            continue;
        }
        if (!isRecord(source)) {
            return Either.ofLeft(new Error('Rallar scope must be an object.'));
        }
        for (const key of ['applicationId', 'workspaceId', 'roomId', 'groupId']) {
            if (source[key] !== undefined && decodeScenarioText(source[key]) === undefined) {
                return Either.ofLeft(new Error(`Rallar scope ${key} must be a scalar identifier.`));
            }
        }
    }
    return Either.ofRight({
        ...toRallarScopeDiagnostics(request),
        ...(minSnapshotVersion !== undefined ? { minSnapshotVersion } : {})
    });
}

export function toRallarRemoteBrowserCommandId(
    action: string,
    interaction: RemoteBrowserCommandIdentityInput
): Either<Error, string> {
    const request = interaction.request;
    const selected = [request.commandId, request.remoteCommandId]
        .find((value) => typeof value === 'string' && value.trim().length > 0);
    if (typeof selected === 'string') {
        return Either.ofRight(selected.trim());
    }
    const parts = ['rallar-remote-browser', action];
    for (
        const [key, prefix] of [
            ['scenarioExecutionNumber', 's'],
            ['interactionExecutionNumber', 'i'],
            ['repeatIndex', 'r'],
            ['connection', ''],
            ['actor', '']
        ] as const
    ) {
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

function toConnectionName(request: Readonly<Record<string, unknown>>): Either<Error, string> {
    const value = [request.connection, request.actor, request.name].find((entry) => entry !== undefined);
    const name = value === undefined ? 'default' : decodeScenarioText(value);
    return name === undefined
        ? Either.ofLeft(new Error('Remote command connection must be a scalar identifier.'))
        : Either.ofRight(name);
}

function toValidatedCommand(candidate: unknown): Either<Error, RallarBlackBoxTestCommand> {
    // CRDT has a canonical schema, but is absent from the control protocol's kind switch.
    if (isRecord(candidate) && typeof candidate.kind === 'string' && candidate.kind.startsWith('crdt.')) {
        const validation = validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, candidate);
        return validation.ok
            ? Either.ofRight(candidate as RallarBlackBoxTestCommand)
            : Either.ofLeft(new Error(formatJsonSchemaValidationErrors(validation.errors)));
    }
    const validation = validateRallarBlackBoxTestCommand(candidate);
    return validation.ok
        ? Either.ofRight(candidate as RallarBlackBoxTestCommand)
        : Either.ofLeft(new Error(validation.error));
}

export function toConnectCommand(
    commandId: string,
    interaction: RemoteBrowserCommandInteraction
): Either<Error, RallarBlackBoxTestCommand> {
    const request = interaction.request;
    const scope = toRallarScopeFields(request);
    const connection = toConnectionName(request);
    if (scope.right === undefined || connection.right === undefined) {
        return Either.ofLeft(scope.left ?? connection.left ?? new Error('Invalid remote command scope.'));
    }
    const scopeFields = scope.right;
    if (request.actor !== undefined && decodeScenarioText(request.actor) === undefined) {
        return Either.ofLeft(new Error('Remote command actor must be a scalar identifier.'));
    }
    return toValidatedCommand({
        kind: 'rtc.connect',
        commandId,
        connection: connection.right,
        actor: request.actor === undefined ? undefined : decodeScenarioText(request.actor),
        roomId: request.roomId === undefined ? undefined : decodeScenarioText(request.roomId),
        ...scopeFields,
        transport: request.transport,
        readiness: request.readiness,
        rallar: {
            ...(isRecord(request.rallar) ? request.rallar : {}),
            ...scopeFields
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
    const connection = toConnectionName(request);
    if (scope.right === undefined || connection.right === undefined) {
        return Either.ofLeft(scope.left ?? connection.left ?? new Error('Invalid remote command scope.'));
    }
    const scopeFields = scope.right;
    const payload: unknown = toRtcPayload(request);
    const send = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? {
            ...payload,
            ...Object.fromEntries(
                Object.entries(scopeFields).filter(([key]) => !(key in payload))
            )
        }
        : {
            data: payload,
            ...scopeFields
        };
    return toValidatedCommand({
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
    const connection = toConnectionName(request);
    if (connection.right === undefined) {
        return Either.ofLeft(connection.left!);
    }
    return toValidatedCommand({
        kind: 'close',
        commandId,
        timeoutMs: request.timeoutMs,
        metadata: {
            ...(request.parity ? { parity: request.parity } : {}),
            connection: connection.right,
            blackBoxRunner: request
        }
    });
}

export function toHealthCommand(
    commandId: string,
    interaction: RemoteBrowserCommandInteraction
): Either<Error, RallarBlackBoxTestCommand> {
    const request = interaction.request;
    const connection = toConnectionName(request);
    if (connection.right === undefined) {
        return Either.ofLeft(connection.left!);
    }
    return toValidatedCommand({
        kind: 'health',
        commandId,
        timeoutMs: interaction.request?.timeoutMs,
        metadata: {
            connection: connection.right,
            blackBoxRunner: interaction.request
        }
    });
}

export function toCrdtCommand(
    commandId: string,
    interaction: RemoteBrowserCommandInteraction
): Either<Error, RallarBlackBoxTestCommand> {
    const request = interaction.request;
    const action = request.action === undefined ? 'open' : request.action;
    if (typeof action !== 'string') {
        return Either.ofLeft(new Error('CRDT action must be a string.'));
    }
    const connection = toConnectionName(request);
    if (connection.right === undefined) {
        return Either.ofLeft(connection.left!);
    }
    const metadata = {
        ...(request.parity ? { parity: request.parity } : {}),
        connection: connection.right,
        blackBoxRunner: request
    };
    const base = { commandId, handle: request.handle, timeoutMs: request.timeoutMs, metadata };
    switch (action) {
        case 'open':
            return toCrdtOpenCommand(commandId, request, metadata);
        case 'apply':
            return toValidatedCommand({ ...base, kind: 'crdt.apply', batch: request.batch });
        case 'sync':
            return toValidatedCommand({
                ...base,
                kind: 'crdt.sync',
                reason: request.reason,
                transport: request.transport
            });
        case 'wait':
            return toValidatedCommand({
                ...base,
                kind: 'crdt.wait',
                intervalMs: request.intervalMs,
                stableForMs: request.stableForMs,
                sync: request.sync,
                conditions: request.conditions
            });
        case 'undo':
        case 'redo':
            return toValidatedCommand({
                ...base,
                kind: action === 'undo' ? 'crdt.undo' : 'crdt.redo',
                targetOperationGroupId: request.targetOperationGroupId,
                operations: request.operations,
                operationGroupId: request.operationGroupId
            });
        case 'read':
        case 'health':
        case 'close':
        case 'destroy':
            return toValidatedCommand({ ...base, kind: `crdt.${action}` });
        default:
            return Either.ofLeft(new Error('Unsupported CRDT action: ' + action));
    }
}

function toCrdtOpenCommand(
    commandId: string,
    request: Readonly<Record<string, unknown>>,
    metadata: Readonly<Record<string, unknown>>
): Either<Error, RallarBlackBoxTestCommand> {
    return toValidatedCommand({
        kind: 'crdt.open',
        commandId,
        handle: request.handle,
        name: request.name,
        applicationId: request.applicationId,
        workspaceId: request.workspaceId,
        documentId: request.documentId,
        documentType: request.documentType,
        scope: request.scope,
        roomRef: request.roomRef,
        principalId: request.principalId,
        customScope: request.customScope,
        transport: request.transport,
        persist: request.persist,
        tabSync: request.tabSync,
        initialValue: request.initialValue,
        policies: request.policies,
        validation: request.validation,
        encryption: request.encryption,
        durableCatchUp: request.durableCatchUp,
        timeoutMs: request.timeoutMs,
        metadata
    });
}
