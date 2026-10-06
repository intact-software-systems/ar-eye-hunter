import { isDeepStrictEqual } from 'node:util';

import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';
import {
    toRtcNativeObservationProjection,
    type RtcNativeProjection
} from '../../../packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts';
import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import { jsonRecord, type LiveRtcJsonRecord } from './live-rtc-evidence-json.ts';
import {
    computeLiveRtcRecorderScanWindow,
    LIVE_RTC_LIFECYCLE_LIMITS,
    toLiveRtcRecorderLines,
    toLiveRtcRecorderRow,
    type LiveRtcRecorderScanInput
} from './live-rtc-recorder-rows.ts';

interface LiveRtcNativeAcquisitionInput extends LiveRtcRecorderScanInput {
    readonly endpoint: string;
    readonly connection: LiveRtcControlClient.CapturedConnection;
    readonly bytesRead: number;
    readonly retainedBytes: number;
}

/** Matches a bounded recorder observation to facts already admitted by the Connect owner. */
export function toLiveRtcNativeAcquisition(
    input: LiveRtcNativeAcquisitionInput
): Either<LiveRtcControlClient.NativeAcquisitionFailure, LiveRtcControlClient.NativeAcquisitionProof> {
    const { connection } = input;
    const scan = scanLiveRtcNativeAcquisition(input);
    const source: LiveRtcControlClient.NativeAcquisitionProof['source'] = {
        endpoint: input.endpoint,
        durableOrigin: 'unknown',
        bytesRead: input.bytesRead,
        retainedBytes: input.retainedBytes,
        retainedPrefixDropped: input.retainedPrefixDropped,
        transportTruncated: input.transportTruncated,
        malformedRows: scan.malformedRows,
        oversizedRows: scan.oversizedRows,
        scanLimited: computeLiveRtcRecorderScanWindow(input).rowLimitReached
    };
    const receipt = connection.receipt;
    const nativeEnabled = receipt.configuration.mode === 'native' && receipt.application.status === 'applied' &&
        receipt.application.mode === 'native' && receipt.connectionId.status === 'observed' &&
        receipt.nativeScopeId.status === 'observed' && receipt.nativeAvailability.status === 'observed' &&
        receipt.nativeAvailability.value === 'enabled' && ['attached', 'partial'].includes(receipt.nativeCoverage);
    const reason = !nativeEnabled
        ? 'native-capture-unavailable'
        : !scan.connectObserved
        ? 'connect-result-unavailable'
        : scan.disposed
        ? 'native-scope-disposed'
        : !scan.initialized
        ? 'initialized-status-unavailable'
        : undefined;
    return reason || !scan.initialized
        ? Either.ofLeft({
            reason: reason ?? 'initialized-status-unavailable',
            connection,
            source,
            cause: new Error('RTC Native acquisition refused.')
        })
        : Either.ofRight({ connection, initialized: scan.initialized, source });
}

interface LiveRtcNativeAcquisitionScan {
    readonly connectObserved: boolean;
    readonly initialized: LiveRtcControlClient.NativeAcquisitionProof['initialized'] | undefined;
    readonly disposed: boolean;
    readonly malformedRows: number;
    readonly oversizedRows: number;
}

function scanLiveRtcNativeAcquisition(input: LiveRtcNativeAcquisitionInput): LiveRtcNativeAcquisitionScan {
    const { connection } = input;
    let connectObserved = false;
    let initialized: LiveRtcControlClient.NativeAcquisitionProof['initialized'] | undefined;
    let disposed = false;
    let malformedRows = 0;
    let oversizedRows = 0;
    for (const { line } of toLiveRtcRecorderLines(input)) {
        if (Buffer.byteLength(line) > LIVE_RTC_LIFECYCLE_LIMITS.rowBytes) {
            oversizedRows += 1;
            continue;
        }
        const row = toLiveRtcRecorderRow(line);
        if (!row) {
            malformedRows += 1;
            continue;
        }
        connectObserved ||= matchesAdmittedConnect({ row, connection });
        const projected = toAcquiredNativeProjection({ row, connection });
        if (projected.recognized && !projected.event) {
            malformedRows += 1;
        }
        const event = projected.event;
        if (!event || event.localSessionId !== connection.sessionId) {
            continue;
        }
        const captures = toNativeAcquisitionCaptures(event).filter((capture) =>
            isDeepStrictEqual(capture.scopeId, connection.receipt.nativeScopeId)
        );
        if (
            captures.some((capture) => capture.scope === 'disposed') ||
            (captures.length > 0 && event.kind === 'native-observation-status' && event.stage === 'disposed')
        ) {
            disposed = true;
        }
        if (
            event.kind === 'native-observation-status' && event.stage === 'initialized' &&
            captures.some((capture) => capture.scope === 'active') &&
            isDeepStrictEqual(event.availability, { status: 'observed', value: 'enabled' })
        ) {
            initialized = event;
        }
    }
    return { connectObserved, initialized, disposed, malformedRows, oversizedRows };
}

function toNativeAcquisitionCaptures(event: ApiJsonObject): readonly ApiJsonObject[] {
    const bodies = [event, event.native, event.candidate, event.service].filter(isNativeAcquisitionRecord);
    const service = bodies.find((body) => body === event.service);
    if (isNativeAcquisitionRecord(service?.native)) {
        bodies.push(service.native);
    }
    return bodies.map((body) => body.capture).filter(isNativeAcquisitionRecord);
}

function isNativeAcquisitionRecord(value: ApiJsonValue | undefined): value is ApiJsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface LiveRtcRecorderConnectionRow {
    readonly row: LiveRtcJsonRecord;
    readonly connection: LiveRtcControlClient.CapturedConnection;
}

function matchesAdmittedConnect(input: LiveRtcRecorderConnectionRow): boolean {
    const { row, connection } = input;
    const actual = jsonRecord(row.actual);
    return row.kind === 'step-result' && row.status === 'SUCCESS' && row.action === 'rtc.connect' &&
        row.agentId === connection.agentId && row.commandId === connection.commandId &&
        row.transport === connection.transport && row.connection === connection.connection &&
        actual?.sessionId === connection.sessionId &&
        isDeepStrictEqual(actual.rtcCapture, { status: 'observed', value: connection.receipt });
}

function toAcquiredNativeProjection(
    input: LiveRtcRecorderConnectionRow
): RtcNativeProjection {
    const { row, connection } = input;
    const runtime = jsonRecord(row.value);
    if (
        row.kind !== 'rtc-diagnostic' || row.agentId !== connection.agentId ||
        runtime?.topic !== 'rallar.browser.rtc.signaling_diagnostics'
    ) {
        return { recognized: false, event: undefined };
    }
    const payload = jsonRecord(runtime.payload);
    return toRtcNativeObservationProjection(payload?.data);
}
