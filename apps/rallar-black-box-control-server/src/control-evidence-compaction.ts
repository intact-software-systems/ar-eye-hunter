import type {
    ControlEventEnvelope,
    ControlResultEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    RallarBlackBoxTestRedactionOptions
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
export function toCompactedControlReport(
    envelope: ControlEventEnvelope,
    redaction: RallarBlackBoxTestRedactionOptions | undefined
): ControlEventEnvelope {
    return {
        ...envelope,
        payload: redactRallarBlackBoxValue(compactReportPayload(envelope.payload), redaction)
    };
}
export function toControlReportDedupeKey(envelope: ControlEventEnvelope): string {
    const payload = isRecord(envelope.payload) ? envelope.payload : undefined;
    const report = payload && isRecord(payload.payload) ? payload.payload : undefined;
    const reportId = report && typeof report.reportId === 'string' ? report.reportId : undefined;
    return [
        envelope.runId,
        envelope.agentId,
        envelope.eventId ?? reportId ?? envelope.atEpochMs
    ].join('\u0000');
}
function compactReportPayload(payload: unknown): unknown {
    if (!isRecord(payload)) {
        return payload;
    }

    if (!isRecord(payload.payload)) {
        return payload;
    }
    const nestedPayload = compactReportValue(payload.payload);
    return nestedPayload === payload.payload ? payload : {
        ...payload,
        payload: nestedPayload
    };
}

function compactReportValue(value: unknown): unknown {
    if (!isRecord(value)) {
        return value;
    }

    const resultCount = Array.isArray(value.results) ? value.results.length : undefined;
    const eventCount = Array.isArray(value.events) ? value.events.length : undefined;
    if (resultCount === undefined && eventCount === undefined) {
        return value;
    }

    const { results: _results, events: _events, ...rest } = value;
    const summary = isRecord(rest.summary) ? rest.summary : {};
    return {
        ...rest,
        summary: {
            ...summary,
            ...(resultCount === undefined ? {} : { omittedResultCount: resultCount }),
            ...(eventCount === undefined ? {} : { omittedEventCount: eventCount })
        }
    };
}

export function compactResultEnvelope(envelope: ControlResultEnvelope): ControlResultEnvelope {
    const result = envelope.result;
    if (!result || !isRecord(result.value) || !Array.isArray(result.value.results)) {
        return envelope;
    }

    return {
        ...envelope,
        result: {
            ...result,
            value: compactRecipeRunValue(result.value)
        }
    };
}

function compactRecipeRunValue(value: Record<string, unknown>): Record<string, unknown> {
    const childResults = Array.isArray(value.results) ? value.results : [];
    const failedChildren = childResults.filter(isFailedCompositeChild);
    const failures = failedChildren.slice(0, 20).map(compactChildFailure);
    const { results: _results, ...rest } = value;
    return {
        ...rest,
        resultCount: childResults.length,
        failureCount: failedChildren.length,
        ...(failures.length > 0 ? { failures } : {}),
        resultsOmitted: true
    };
}

function isFailedCompositeChild(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    if (value.ok === false) {
        return true;
    }
    return isRecord(value.result) && value.result.ok === false;
}

function compactChildFailure(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) {
        return { value };
    }
    const result = isRecord(value.result) ? value.result : undefined;
    const error = isRecord(value.error)
        ? value.error
        : result && isRecord(result.error)
        ? result.error
        : undefined;
    return {
        commandId: value.commandId ?? result?.commandId,
        kind: value.kind ?? result?.kind,
        status: value.status ?? result?.status,
        ok: value.ok ?? result?.ok,
        error: error
            ? {
                code: error.code,
                message: error.message
            }
            : undefined
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
