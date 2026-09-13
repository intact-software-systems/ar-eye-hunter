import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import {
    jsonRecord,
    stringValue,
    type LiveRtcJsonRecord
} from './live-rtc-evidence-json.ts';
import type {
    LiveRtcFailedControlResult,
    LiveRtcNackSendResultSummary,
    LiveRtcSendResultSummary
} from './live-rtc-performance-evidence.ts';

const MAX_RETAINED_SEND_ENTRY_STATUSES = 20;

export function summarizeLiveRtcSendResult(
    result: LiveRtcControlClient.Result | undefined
): LiveRtcSendResultSummary | undefined {
    if (!result) {
        return undefined;
    }
    const diagnostics = toCommandDiagnostics(result);
    const admission = jsonRecord(diagnostics.message) ?? {};
    const entries = Array.isArray(admission.entries) ? admission.entries : [];
    return {
        ok: result.ok,
        runtimeStatus: classifyRuntimeStatus(stringValue(diagnostics.status)),
        admissionStatus: classifyAdmissionStatus(stringValue(admission.status)),
        reason: classifyReason(stringValue(admission.reason)),
        messageIdPresent: messageIdFromDiagnostics(diagnostics) !== undefined,
        entryCount: entries.length,
        entryStatuses: entries
            .slice(0, MAX_RETAINED_SEND_ENTRY_STATUSES)
            .map((entry) => classifyEntryStatus(stringValue(jsonRecord(entry)?.status)))
    };
}

export function summarizeNackSendResult(
    result: LiveRtcControlClient.Result | undefined,
    probeMessageId: string | null
): LiveRtcNackSendResultSummary | undefined {
    const summary = summarizeLiveRtcSendResult(result);
    if (!summary || !result) {
        return undefined;
    }
    return {
        ...summary,
        messageIdMatchesProbe: probeMessageId === null
            ? null
            : messageIdFromDiagnostics(toCommandDiagnostics(result)) === probeMessageId
    };
}

export function toFailedControlResult(
    result: LiveRtcControlClient.Result & { ok: false; }
): LiveRtcFailedControlResult {
    const diagnostics = toCommandDiagnostics(result);
    const admission = jsonRecord(diagnostics.message) ?? {};
    const entries = Array.isArray(admission.entries) ? admission.entries : [];
    return {
        agentId: result.agentId ?? null,
        commandId: result.commandId,
        ok: false,
        runtimeStatus: missingToNull(
            classifyRuntimeStatus(stringValue(diagnostics.status))
        ),
        admissionStatus: missingToNull(
            classifyAdmissionStatus(stringValue(admission.status))
        ),
        reason: missingToNull(classifyReason(stringValue(admission.reason))),
        entryCount: entries.length,
        entryStatuses: entries
            .slice(0, MAX_RETAINED_SEND_ENTRY_STATUSES)
            .map((entry) => classifyEntryStatus(stringValue(jsonRecord(entry)?.status)))
    };
}

function toCommandDiagnostics(
    result: LiveRtcControlClient.Result
): LiveRtcJsonRecord {
    if (result.ok) {
        return jsonRecord(result.result?.value) ?? {};
    }
    return jsonRecord(jsonRecord(result.error)?.details) ?? {};
}

function messageIdFromDiagnostics(
    diagnostics: LiveRtcJsonRecord
): string | undefined {
    const admission = jsonRecord(diagnostics.message) ?? {};
    return stringValue(jsonRecord(jsonRecord(admission.message)?.id)?.msgId);
}

function classifyRuntimeStatus(
    value: string | undefined
): LiveRtcSendResultSummary['runtimeStatus'] {
    return value === undefined ? 'missing' : value === 'sent' ? 'sent' : 'other';
}

function classifyReason(
    value: string | undefined
): LiveRtcSendResultSummary['reason'] {
    return value === undefined
        ? 'missing'
        : value === 'not-yet-in-sync'
        ? value
        : 'other';
}

function classifyAdmissionStatus(
    value: string | undefined
): LiveRtcSendResultSummary['admissionStatus'] {
    switch (value) {
        case 'accepted':
        case 'enqueued':
        case 'skipped':
        case 'duplicate':
        case 'pending-admission':
        case 'superseded':
        case 'expired':
        case 'no-route':
        case 'rate-limited':
        case 'circuit-open':
        case 'failed':
            return value;
        default:
            return value === undefined ? 'missing' : 'other';
    }
}

function classifyEntryStatus(
    value: string | undefined
): LiveRtcSendResultSummary['entryStatuses'][number] {
    switch (value) {
        case 'NEW':
        case 'RETRY':
        case 'RESERVED':
        case 'COMPLETED':
        case 'FAILED':
        case 'ABORTED':
        case 'NON_RETRYABLE':
        case 'PARTITIONED':
        case 'MERGED':
            return value;
        default:
            return 'other';
    }
}

function missingToNull<T extends string>(value: T | 'missing'): T | null {
    return value === 'missing' ? null : value;
}
