import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

import { toCommandIdSegment } from '../control-command-queue-policy.ts';
import type { EnqueueControlCommandInput } from '../control-service.ts';
import type { ControlHttpRejection } from '../http/control-http-responses.ts';
import {
    validateBrowserCommandDestination,
    type BrowserCommandDestinationPolicy
} from '../validate-browser-command-destination.ts';
import { toForbiddenDestinationRejection } from './control-route-errors.ts';

export interface CommandRequest {
    readonly command: RallarBlackBoxTestCommand;
    readonly commandId: string | undefined;
    readonly deadlineEpochMs: number | undefined;
}

export interface BulkCommandRequest {
    readonly agentIds: readonly string[];
    readonly command: RallarBlackBoxTestCommand;
    readonly baseCommandId: string | undefined;
    readonly hasExplicitCommandId: boolean;
    readonly deadlineEpochMs: number | undefined;
}

export interface BulkCommandTarget {
    readonly runId: string;
    readonly request: BulkCommandRequest;
    readonly nowEpochMs: number;
}

const BULK_AGENT_ID_FALLBACK_SEGMENT = 'agent';

export function decodeCommandRequest(body: unknown): Either<string, CommandRequest> {
    if (!isJsonRecordValue(body) || !('command' in body)) {
        return Either.ofLeft('Command request requires command.');
    }
    const validation = validateRallarBlackBoxTestCommand(body.command);
    if (!validation.ok) {
        return Either.ofLeft(validation.error);
    }
    const commandId = body.commandId ?? undefined;
    if (commandId !== undefined && typeof commandId !== 'string') {
        return Either.ofLeft('Command request commandId must be a string.');
    }
    const deadlineEpochMs = body.deadlineEpochMs ?? undefined;
    if (deadlineEpochMs !== undefined && typeof deadlineEpochMs !== 'number') {
        return Either.ofLeft('Command request deadlineEpochMs must be a number.');
    }

    return Either.ofRight({
        command: body.command as RallarBlackBoxTestCommand,
        commandId,
        deadlineEpochMs
    });
}

export function decodeBulkCommandRequest(body: unknown): Either<string, BulkCommandRequest> {
    if (!isJsonRecordValue(body) || !('command' in body)) {
        return Either.ofLeft('Bulk command request requires command.');
    }
    const agentIds = Array.isArray(body.agentIds)
        ? body.agentIds.map(decodeTrimmedText).filter((agentId) => agentId !== undefined)
        : [];
    if (agentIds.length === 0) {
        return Either.ofLeft('Bulk command request requires agentIds.');
    }
    const validation = validateRallarBlackBoxTestCommand(body.command);
    if (!validation.ok) {
        return Either.ofLeft(validation.error);
    }

    const command = body.command as RallarBlackBoxTestCommand;
    return Either.ofRight({
        agentIds,
        command,
        baseCommandId: decodeTrimmedText(body.commandId) ?? decodeTrimmedText(body.commandIdPrefix) ??
            decodeTrimmedText(command.commandId),
        hasExplicitCommandId: typeof body.commandId === 'string',
        deadlineEpochMs: typeof body.deadlineEpochMs === 'number' ? body.deadlineEpochMs : undefined
    });
}

export function toDestinationAdmittedRequest<TRequest extends CommandRequest | BulkCommandRequest>(
    request: TRequest,
    policy: BrowserCommandDestinationPolicy
): Either<ControlHttpRejection, TRequest> {
    const destinationIssues = validateBrowserCommandDestination(request.command, policy);
    return destinationIssues.length > 0
        ? Either.ofLeft(toForbiddenDestinationRejection(destinationIssues))
        : Either.ofRight(request);
}

export function toBulkCommandInputs({ runId, request, nowEpochMs }: BulkCommandTarget): EnqueueControlCommandInput[] {
    return request.agentIds.map((agentId, index) => {
        const commandId = toBulkAgentCommandId(request, agentId);
        return {
            runId,
            agentId,
            commandId: commandId ?? `bulk-${nowEpochMs}-${index + 1}`,
            command: commandId ? { ...request.command, commandId } : request.command,
            deadlineEpochMs: request.deadlineEpochMs
        };
    });
}

function toBulkAgentCommandId(request: BulkCommandRequest, agentId: string): string | undefined {
    if (request.baseCommandId === undefined) {
        return undefined;
    }
    return request.agentIds.length === 1 && request.hasExplicitCommandId
        ? request.baseCommandId
        : `${request.baseCommandId}-${toCommandIdSegment(agentId, BULK_AGENT_ID_FALLBACK_SEGMENT)}`;
}

function decodeTrimmedText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
