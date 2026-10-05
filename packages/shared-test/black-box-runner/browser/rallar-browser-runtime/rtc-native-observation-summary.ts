import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';
import { RTC_NATIVE_OBSERVATION_KINDS } from './rtc-native-observation-projection.ts';

export interface RtcNativeSummaryInput {
    readonly events: readonly ApiJsonObject[];
    readonly malformedRows: boolean;
    readonly streamAvailable: boolean;
    readonly artifactTruncated: boolean;
}

/** Summarizes only received, validated rows from the existing bounded artifact suffix. */
export function toRtcNativeObservationSummary(input: RtcNativeSummaryInput): ApiJsonObject {
    const rows = input.events.filter((event) =>
        typeof event.kind === 'string' && RTC_NATIVE_OBSERVATION_KINDS.some((kind) => kind === event.kind)
    );
    let scope: string | undefined;
    let exactScope = true;
    let capability: ApiJsonValue = { status: 'unavailable', reason: 'absent' };
    let sourceAdmissionLimited = false;
    let sourceOrdinaryLimited = false;
    let sourcePayloadLimited = false;
    for (const row of rows) {
        const body = toJsonObject(row.native) ?? toJsonObject(row.candidate) ?? toJsonObject(row.service) ?? row;
        const capture = toJsonObject(body.capture);
        const identity = toJsonObject(capture?.scopeId);
        if (identity?.status !== 'observed' || typeof identity.value !== 'string') {
            exactScope = false;
        }
        else if (scope !== undefined && scope !== identity.value) {
            exactScope = false;
        }
        else {
            scope = identity.value;
        }
        sourceAdmissionLimited ||= capture?.admissionLimited === true || row.limit === 'admission';
        sourceOrdinaryLimited ||= capture?.ordinaryRowsSuppressed === true || row.limit === 'ordinary-rows';
        sourcePayloadLimited ||= capture?.payloadLimited === true || row.limit === 'payload-bytes' ||
            row.kind === 'native-observation-unavailable';
        if (row.kind === 'native-observation-status' && row.stage === 'initialized') {
            capability = row.availability;
        }
    }
    const received = rows.length > 0;
    return {
        status: received ? 'observations-present' : 'unavailable',
        delivery: received ? 'received' : input.streamAvailable ? 'missing-or-failed' : 'stream-unavailable',
        coverage: received ? 'bounded-partial' : 'unavailable',
        malformedRows: input.malformedRows,
        sourceAdmissionLimited,
        sourceOrdinaryLimited,
        sourcePayloadLimited,
        artifactTruncated: input.artifactTruncated,
        capability: exactScope && scope !== undefined ? capability : { status: 'unavailable', reason: 'absent' }
    };
}

function toJsonObject(value: ApiJsonValue | undefined): ApiJsonObject | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ApiJsonObject : undefined;
}
