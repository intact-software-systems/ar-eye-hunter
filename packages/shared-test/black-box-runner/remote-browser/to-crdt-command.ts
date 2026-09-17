import type { ApiJsonObject } from '../../../shared/api/api-json-value.ts';
import { Either } from '../../../shared/resilience/Either.ts';

import type { RallarBlackBoxTestCommand } from '../../rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    decodeRemoteBrowserCommand,
    toRemoteBrowserConnectionName,
    type RemoteBrowserCommandInteraction
} from './decode-remote-browser-command.ts';

interface CrdtDocumentCommandInput {
    readonly action: string;
    readonly commandId: string;
    readonly request: ApiJsonObject;
    readonly metadata: ApiJsonObject;
}

/** A CRDT step without an action opens its document. */
export function toCrdtCommand(
    commandId: string,
    interaction: RemoteBrowserCommandInteraction
): Either<Error, RallarBlackBoxTestCommand> {
    const request = interaction.request;
    const action = request.action === undefined ? 'open' : request.action;
    if (typeof action !== 'string') {
        return Either.ofLeft(new Error('CRDT action must be a string.'));
    }
    return toRemoteBrowserConnectionName(request).flatMap(
        (error) => Either.ofLeft(error),
        (connection) => {
            const metadata = {
                ...(request.parity ? { parity: request.parity } : {}),
                connection,
                blackBoxRunner: request
            };
            return action === 'open'
                ? toCrdtOpenCommand(commandId, request, metadata)
                : toCrdtDocumentCommand({ action, commandId, request, metadata });
        }
    );
}

function toCrdtDocumentCommand(input: CrdtDocumentCommandInput): Either<Error, RallarBlackBoxTestCommand> {
    const { action, commandId, request, metadata } = input;
    const base = { commandId, handle: request.handle, timeoutMs: request.timeoutMs, metadata };
    switch (action) {
        case 'apply':
            return decodeRemoteBrowserCommand({ ...base, kind: 'crdt.apply', batch: request.batch });
        case 'sync':
            return decodeRemoteBrowserCommand({
                ...base,
                kind: 'crdt.sync',
                reason: request.reason,
                transport: request.transport
            });
        case 'wait':
            return decodeRemoteBrowserCommand({
                ...base,
                kind: 'crdt.wait',
                intervalMs: request.intervalMs,
                stableForMs: request.stableForMs,
                sync: request.sync,
                conditions: request.conditions
            });
        case 'undo':
        case 'redo':
            return decodeRemoteBrowserCommand({
                ...base,
                kind: `crdt.${action}`,
                targetOperationGroupId: request.targetOperationGroupId,
                operations: request.operations,
                operationGroupId: request.operationGroupId
            });
        case 'read':
        case 'health':
        case 'close':
        case 'destroy':
            return decodeRemoteBrowserCommand({ ...base, kind: `crdt.${action}` });
        default:
            return Either.ofLeft(new Error('Unsupported CRDT action: ' + action));
    }
}

function toCrdtOpenCommand(
    commandId: string,
    request: ApiJsonObject,
    metadata: ApiJsonObject
): Either<Error, RallarBlackBoxTestCommand> {
    return decodeRemoteBrowserCommand({
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
