// deno-lint-ignore-file no-explicit-any
import { Either } from '../../../shared/resilience/Either.ts';

import type { RallarBlackBoxTestCommand } from '../../rallar-bb-test/types.ts';
import { isRecord } from '../execution/black-box-redaction.ts';
import { toRallarScopeDiagnostics } from '../recipes/recipe-rallar-scope.ts';
import { toRtcPayload } from '../rtc-provider.ts';
import { toRtcConnectionName } from '../rtc/rtc-wait-expectations.ts';

export function toRallarScopeFields(request: any): Record<string, unknown> {
    const rallar = isRecord(request.rallar) ? request.rallar : {};
    const minSnapshotVersion = [request.minSnapshotVersion, rallar.minSnapshotVersion].find((value) =>
        value !== undefined
    );
    return {
        ...toRallarScopeDiagnostics(request),
        ...(minSnapshotVersion !== undefined ? { minSnapshotVersion } : {})
    };
}

export function toRallarRemoteBrowserCommandId(action: string, interaction: any): string {
    const request = interaction.request ?? {};
    const fallback = [
        'rallar-remote-browser',
        action,
        request.scenarioExecutionNumber !== undefined ? `s${request.scenarioExecutionNumber}` : undefined,
        request.interactionExecutionNumber !== undefined ? `i${request.interactionExecutionNumber}` : undefined,
        request.repeatIndex !== undefined ? `r${request.repeatIndex}` : undefined,
        request.connection,
        request.actor
    ].filter((value) => value !== undefined && value !== null && value !== '').join('-');
    const selected = [request.commandId, request.remoteCommandId]
        .find((value) => typeof value === 'string' && value.trim().length > 0);
    return selected === undefined ? fallback : selected.trim();
}

function toTransport(request: any): 'realtime' | 'messages.rtc' | undefined {
    return request.transport === 'messages.rtc' ? 'messages.rtc' : request.transport === 'realtime'
        ? 'realtime'
        : undefined;
}

export function toConnectCommand(commandId: string, interaction: any): RallarBlackBoxTestCommand {
    const request = interaction.request;
    const scopeFields = toRallarScopeFields(request);
    return {
        kind: 'rtc.connect',
        commandId,
        connection: toRtcConnectionName(request),
        actor: request.actor,
        roomId: request.roomId,
        ...scopeFields,
        transport: toTransport(request),
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
    };
}

export function toSendCommand(commandId: string, interaction: any): RallarBlackBoxTestCommand {
    const request = interaction.request;
    const scopeFields = toRallarScopeFields(request);
    const payload = toRtcPayload(request);
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
    return {
        kind: 'rtc.send',
        commandId,
        connection: toRtcConnectionName(request),
        send,
        ...scopeFields,
        transport: toTransport(request),
        timeoutMs: request.timeoutMs,
        metadata: {
            ...(request.parity ? { parity: request.parity } : {}),
            blackBoxRunner: request
        }
    };
}

export function toCloseCommand(commandId: string, interaction: any): RallarBlackBoxTestCommand {
    const request = interaction.request;
    return {
        kind: 'close',
        commandId,
        timeoutMs: request.timeoutMs,
        metadata: {
            ...(request.parity ? { parity: request.parity } : {}),
            connection: toRtcConnectionName(request),
            blackBoxRunner: request
        }
    };
}

export function toHealthCommand(commandId: string, interaction: any): RallarBlackBoxTestCommand {
    return {
        kind: 'health',
        commandId,
        timeoutMs: interaction.request?.timeoutMs,
        metadata: {
            connection: toRtcConnectionName(interaction.request ?? {}),
            blackBoxRunner: interaction.request
        }
    };
}

export function toCrdtCommand(commandId: string, interaction: any): Either<Error, RallarBlackBoxTestCommand> {
    const request = interaction.request;
    const action = String(request.action || 'open');
    const metadata = {
        ...(request.parity ? { parity: request.parity } : {}),
        connection: toRtcConnectionName(request),
        blackBoxRunner: request
    };
    const base = { commandId, handle: request.handle, timeoutMs: request.timeoutMs, metadata };
    switch (action) {
        case 'open':
            return Either.ofRight(toCrdtOpenCommand(commandId, request, metadata));
        case 'apply':
            return Either.ofRight({ ...base, kind: 'crdt.apply', batch: request.batch });
        case 'sync':
            return Either.ofRight({ ...base, kind: 'crdt.sync', reason: request.reason, transport: request.transport });
        case 'wait':
            return Either.ofRight({
                ...base,
                kind: 'crdt.wait',
                intervalMs: request.intervalMs,
                stableForMs: request.stableForMs,
                sync: request.sync,
                conditions: request.conditions
            });
        case 'undo':
        case 'redo':
            return Either.ofRight({
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
            return Either.ofRight({ ...base, kind: `crdt.${action}` });
        default:
            return Either.ofLeft(new Error('Unsupported CRDT action: ' + action));
    }
}

function toCrdtOpenCommand(commandId: string, request: any, metadata: any): RallarBlackBoxTestCommand {
    return {
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
    };
}
