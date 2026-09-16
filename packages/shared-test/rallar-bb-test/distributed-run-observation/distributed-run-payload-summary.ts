import type { ControlRunSnapshot } from '../control-snapshots.ts';

type ControlEventSnapshot = ControlRunSnapshot['events'][number];

export function summarizeDistributedRunPayload(value: unknown): string {
    if (value === undefined) {
        return '';
    }
    if (typeof value === 'string') {
        return value.length > 180 ? `${value.slice(0, 177)}...` : value;
    }
    try {
        const text = JSON.stringify(value);
        return text.length > 180 ? `${text.slice(0, 177)}...` : text;
    }
    catch (_caught) {
        return String(value);
    }
}

export function toDistributedRunPayloadTopic(payload: unknown): string | undefined {
    if (!isPayloadRecord(payload)) {
        return undefined;
    }
    return decodeNonBlankText(payload.topic) ??
        decodeNonBlankText(payload.name) ??
        decodeNonBlankText(payload.eventTopic);
}

export function toDistributedRunEventSummary(event: ControlEventSnapshot): string {
    const payload = event.payload;
    if (isPayloadRecord(payload)) {
        const direct = decodeNonBlankText(payload.message) ??
            decodeNonBlankText(payload.status) ??
            decodeNonBlankText(payload.name) ??
            decodeNonBlankText(payload.kind) ??
            decodeNonBlankText(payload.topic);
        if (direct) {
            return direct;
        }
    }
    return summarizeDistributedRunPayload(payload);
}

export function decodeFirstNonBlankText(...values: readonly unknown[]): string | undefined {
    return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

export function decodeNonBlankText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function isPayloadRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function payloadReferencesDistributedRun(payload: unknown, distributedRunId: string): boolean {
    if (!payload || !distributedRunId) {
        return false;
    }
    try {
        return JSON.stringify(payload).includes(distributedRunId);
    }
    catch (_caught) {
        return false;
    }
}
