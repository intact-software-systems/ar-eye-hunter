import { Either } from '@shared/resilience/Either.ts';

import type { ControlEventEnvelope, ControlResultEnvelope } from '../control-protocol.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMMAND_KINDS,
    type RallarBlackBoxTestResult,
    type RallarBlackBoxTestResultStatus
} from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { isFiniteNumber, isNonEmptyText, isOneOf } from './artifact-json-value-guards.ts';
import { CONTROL_EVENT_ENVELOPE_KINDS } from './decode-control-run-snapshot.ts';
import { decodeResultCommandId } from './decode-distributed-run-result-evidence.ts';

const RESULT_STATUSES = Object.keys(
    { ok: true, failed: true, cancelled: true, skipped: true } satisfies Record<RallarBlackBoxTestResultStatus, true>
) as readonly RallarBlackBoxTestResultStatus[];

const RECORDER_OUTCOMES = ['SUCCESS', 'FAILURE'] as const;

/**
 * A row stands in for a control result only when it carries the agent, command and outcome the
 * envelope requires; the control artifact recorder writes `agentId:commandId` result keys.
 */
export function decodeJsonlControlResultEnvelope(
    value: unknown,
    runId: string
): Either<string, ControlResultEnvelope> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('the row must be a JSON object');
    }
    if (!isNonEmptyText(value.agentId)) {
        return Either.ofLeft('agentId must be a non-empty string');
    }
    const commandId = decodeResultCommandId(value.commandId, value.resultKey);
    if (commandId === undefined) {
        return Either.ofLeft('commandId or an agentId:commandId resultKey must name the command');
    }
    const ok = typeof value.ok === 'boolean' ? value.ok : decodeRecorderOutcome(value.status);
    if (ok === undefined) {
        return Either.ofLeft('ok must be a boolean or status must be SUCCESS or FAILURE');
    }
    const error = ok ? undefined : decodeResultError(value.error ?? value.actual);
    return Either.ofRight({
        kind: 'result',
        protocolVersion: 1,
        runId,
        agentId: value.agentId,
        commandId,
        ok,
        ...(isTestResult(value.result) ? { result: value.result } : {}),
        ...(error === undefined ? {} : { error }),
        ...(typeof value.replayed === 'boolean' ? { replayed: value.replayed } : {})
    });
}

/** The recorder writes the control envelope kind as `status` and its payload as `value`. */
export function decodeJsonlControlEventEnvelope(
    value: unknown,
    runId: string
): Either<string, ControlEventEnvelope> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('the row must be a JSON object');
    }
    if (!isNonEmptyText(value.agentId)) {
        return Either.ofLeft('agentId must be a non-empty string');
    }
    if (!isFiniteNumber(value.atEpochMs)) {
        return Either.ofLeft('atEpochMs must be a finite number');
    }
    const kind = isOneOf(value.kind, CONTROL_EVENT_ENVELOPE_KINDS)
        ? value.kind
        : isOneOf(value.status, CONTROL_EVENT_ENVELOPE_KINDS)
        ? value.status
        : undefined;
    if (kind === undefined) {
        return Either.ofLeft('kind or status must be event, diagnostic, stats or report');
    }
    const payload = value.value !== undefined ? value.value : value.payload;
    if (payload === undefined) {
        return Either.ofLeft('value or payload must carry the event payload');
    }
    return Either.ofRight({
        kind,
        protocolVersion: 1,
        runId,
        agentId: value.agentId,
        atEpochMs: value.atEpochMs,
        ...(isNonEmptyText(value.eventId) ? { eventId: value.eventId } : {}),
        ...(isNonEmptyText(value.commandId) ? { commandId: value.commandId } : {}),
        payload
    });
}

function decodeRecorderOutcome(status: unknown): boolean | undefined {
    return isOneOf(status, RECORDER_OUTCOMES) ? status === 'SUCCESS' : undefined;
}

function decodeResultError(value: unknown): ControlResultEnvelope['error'] {
    if (!isJsonRecordValue(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
        return undefined;
    }
    return {
        code: value.code,
        message: value.message,
        ...(value.details === undefined ? {} : { details: value.details })
    };
}

function isTestResult(value: unknown): value is RallarBlackBoxTestResult {
    return isJsonRecordValue(value) &&
        isNonEmptyText(value.commandId) &&
        isOneOf(value.kind, RALLAR_BLACK_BOX_TEST_COMMAND_KINDS) &&
        isOneOf(value.status, RESULT_STATUSES) &&
        typeof value.ok === 'boolean' &&
        isFiniteNumber(value.startedAtEpochMs) &&
        isFiniteNumber(value.endedAtEpochMs) &&
        isFiniteNumber(value.durationMs);
}
