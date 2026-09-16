import type { ControlEventEnvelope, ControlResultEnvelope } from '../control-protocol.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMMAND_KINDS,
    type RallarBlackBoxTestResult
} from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { isFiniteNumber, isNonEmptyText, isOneOf } from './artifact-json-value-guards.ts';

const EVENT_ENVELOPE_KINDS: readonly ControlEventEnvelope['kind'][] = ['event', 'diagnostic', 'stats', 'report'];

const RESULT_STATUSES: readonly RallarBlackBoxTestResult['status'][] = ['ok', 'failed', 'cancelled', 'skipped'];

/**
 * A row stands in for a control result only when it carries the agent, command and outcome the
 * envelope requires; the control artifact recorder writes `agentId:commandId` result keys.
 */
export function decodeJsonlControlResultEnvelope(
    value: unknown,
    runId: string
): ControlResultEnvelope | undefined {
    if (!isJsonRecordValue(value) || !isNonEmptyText(value.agentId)) {
        return undefined;
    }
    const commandId = decodeResultCommandId(value.commandId, value.resultKey);
    const ok = typeof value.ok === 'boolean' ? value.ok : decodeRecorderOutcome(value.status);
    if (commandId === undefined || ok === undefined) {
        return undefined;
    }
    const error = ok ? undefined : decodeResultError(value.error ?? value.actual);
    return {
        kind: 'result',
        protocolVersion: 1,
        runId,
        agentId: value.agentId,
        commandId,
        ok,
        ...(isTestResult(value.result) ? { result: value.result } : {}),
        ...(error === undefined ? {} : { error }),
        ...(typeof value.replayed === 'boolean' ? { replayed: value.replayed } : {})
    };
}

/** The recorder writes the control envelope kind as `status` and its payload as `value`. */
export function decodeJsonlControlEventEnvelope(
    value: unknown,
    runId: string
): ControlEventEnvelope | undefined {
    if (!isJsonRecordValue(value) || !isNonEmptyText(value.agentId) || !isFiniteNumber(value.atEpochMs)) {
        return undefined;
    }
    const kind = isOneOf(value.kind, EVENT_ENVELOPE_KINDS)
        ? value.kind
        : isOneOf(value.status, EVENT_ENVELOPE_KINDS)
        ? value.status
        : undefined;
    const payload = value.value !== undefined ? value.value : value.payload;
    if (kind === undefined || payload === undefined) {
        return undefined;
    }
    return {
        kind,
        protocolVersion: 1,
        runId,
        agentId: value.agentId,
        atEpochMs: value.atEpochMs,
        ...(isNonEmptyText(value.eventId) ? { eventId: value.eventId } : {}),
        ...(isNonEmptyText(value.commandId) ? { commandId: value.commandId } : {}),
        payload
    };
}

function decodeResultCommandId(commandId: unknown, resultKey: unknown): string | undefined {
    if (isNonEmptyText(commandId)) {
        return commandId;
    }
    if (!isNonEmptyText(resultKey)) {
        return undefined;
    }
    const [, keyedCommandId] = resultKey.split(/:(.*)/s);
    return keyedCommandId || resultKey;
}

function decodeRecorderOutcome(status: unknown): boolean | undefined {
    if (status === 'SUCCESS') {
        return true;
    }
    return status === 'FAILURE' ? false : undefined;
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
