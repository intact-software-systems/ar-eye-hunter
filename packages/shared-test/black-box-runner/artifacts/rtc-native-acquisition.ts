import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import { decodeRallarBlackBoxTestResult } from '../../rallar-bb-test/composite-results.ts';
import {
    toRtcNativeObservationProjection,
    type RtcNativeProjection
} from '../browser/rallar-browser-runtime/rtc-native-observation-projection.ts';
import type { RecorderJsonlFailure, RecorderJsonlRead } from './read-recorder-jsonl-rows.ts';

export interface RtcNativeRecipeAttribution {
    readonly rootCommandId: string;
    readonly recipeId: string;
    readonly invocationId: string;
    readonly recipeBodyId: string;
    readonly childIndex: number;
}

export interface RtcNativeCapturedConnection {
    readonly runId: string;
    readonly agentId: string;
    readonly commandId: string;
    readonly connection: string;
    readonly transport: 'realtime' | 'messages.rtc';
    readonly sessionId: string;
    readonly requestedConfiguration: RtcSignalingDiagnostics.CaptureConfiguration;
    readonly receipt: RtcSignalingDiagnostics.CaptureReceipt;
    /** Absence identifies the independently supported standalone Connect path. */
    readonly recipeAttribution?: RtcNativeRecipeAttribution;
}

export interface RtcNativeAcquisitionSource {
    readonly endpoint: string;
    readonly durableOrigin: 'unknown';
    readonly bytesRead: number;
    readonly decodedRecords: number;
    readonly completeness: 'complete' | 'incomplete';
    readonly malformedRows: number;
    readonly oversizedRows: number;
}

export interface RtcNativeAcquisitionProof {
    readonly connection: RtcNativeCapturedConnection;
    readonly initialized: ApiJsonObject;
    readonly source: RtcNativeAcquisitionSource;
}

export interface RtcNativeAcquisitionFailure {
    readonly reason:
        | 'initialized-status-unavailable'
        | 'native-capture-unavailable'
        | 'acquisition-failed'
        | 'connect-result-unavailable'
        | 'native-scope-disposed';
    readonly source: RtcNativeAcquisitionSource | null;
    readonly connection: RtcNativeCapturedConnection;
    readonly cause: Error;
}

export interface RtcNativeAcquisition {
    readRtcNativeAcquisition(
        connection: RtcNativeCapturedConnection
    ): Promise<Either<RtcNativeAcquisitionFailure, RtcNativeAcquisitionProof>>;
}

interface RtcNativeAcquisitionObservation {
    readonly connectObserved: boolean;
    readonly initialized: ApiJsonObject | undefined;
    readonly disposed: boolean;
    readonly malformedRows: number;
}

/** Admission proves only the complete finite supplied source, never its durable origin. */
export async function readRtcNativeAcquisition(
    connection: RtcNativeCapturedConnection,
    endpoint: string,
    rows: AsyncIterable<Either<RecorderJsonlFailure, RecorderJsonlRead>>
): Promise<Either<RtcNativeAcquisitionFailure, RtcNativeAcquisitionProof>> {
    let source: RtcNativeAcquisitionSource = {
        endpoint,
        durableOrigin: 'unknown',
        bytesRead: 0,
        decodedRecords: 0,
        completeness: 'incomplete',
        malformedRows: 0,
        oversizedRows: 0
    };
    let observation: RtcNativeAcquisitionObservation = {
        connectObserved: false,
        initialized: undefined,
        disposed: false,
        malformedRows: 0
    };
    try {
        for await (const read of rows) {
            if (read.left) {
                source = {
                    ...source,
                    bytesRead: read.left.bytesRead,
                    decodedRecords: read.left.decodedRecords,
                    completeness: 'incomplete',
                    malformedRows: read.left.code === 'malformed-jsonl' ? 1 : 0,
                    oversizedRows: read.left.code === 'input-limit' ? 1 : 0
                };
                return toRtcNativeAcquisitionFailure(connection, source.bytesRead ? source : null);
            }
            const record = read.right;
            if (!record || source.completeness === 'complete') {
                return toRtcNativeAcquisitionFailure(connection, { ...source, completeness: 'incomplete' });
            }
            source = { ...source, bytesRead: record.bytesRead, decodedRecords: record.decodedRecords };
            if (record.kind === 'complete') {
                source = { ...source, completeness: 'complete' };
                continue;
            }
            observation = toRtcNativeAcquisitionObservation(record.row, connection, observation);
            if (observation.malformedRows) {
                return toRtcNativeAcquisitionFailure(connection, { ...source, malformedRows: 1 });
            }
        }
    }
    catch {
        return toRtcNativeAcquisitionFailure(connection, { ...source, completeness: 'incomplete' });
    }
    return toRtcNativeAcquisitionProof(connection, source, observation);
}

function toRtcNativeAcquisitionProof(
    connection: RtcNativeCapturedConnection,
    source: RtcNativeAcquisitionSource,
    observation: RtcNativeAcquisitionObservation
): Either<RtcNativeAcquisitionFailure, RtcNativeAcquisitionProof> {
    const receipt = connection.receipt;
    const nativeEnabled = receipt.configuration.mode === 'native' && receipt.application.status === 'applied' &&
        receipt.application.mode === 'native' && receipt.connectionId.status === 'observed' &&
        receipt.nativeScopeId.status === 'observed' && receipt.nativeAvailability.status === 'observed' &&
        receipt.nativeAvailability.value === 'enabled' && ['attached', 'partial'].includes(receipt.nativeCoverage);
    const reason = source.completeness !== 'complete'
        ? 'acquisition-failed'
        : !nativeEnabled
        ? 'native-capture-unavailable'
        : !observation.connectObserved
        ? 'connect-result-unavailable'
        : observation.disposed
        ? 'native-scope-disposed'
        : !observation.initialized
        ? 'initialized-status-unavailable'
        : undefined;
    return reason || !observation.initialized
        ? Either.ofLeft({
            reason: reason ?? 'initialized-status-unavailable',
            connection,
            source,
            cause: new Error('RTC Native acquisition refused.')
        })
        : Either.ofRight({ connection, initialized: observation.initialized, source });
}

function toRtcNativeAcquisitionObservation(
    row: ApiJsonObject,
    connection: RtcNativeCapturedConnection,
    observation: RtcNativeAcquisitionObservation
): RtcNativeAcquisitionObservation {
    const connectObserved = observation.connectObserved || matchesAdmittedConnect(row, connection);
    const projected = toAcquiredNativeProjection(row, connection);
    if (projected.recognized && !projected.event) {
        return { ...observation, connectObserved, malformedRows: 1 };
    }
    const event = projected.event;
    if (!event || event.localSessionId !== connection.sessionId) {
        return { ...observation, connectObserved };
    }
    const captures = toNativeAcquisitionCaptures(event).filter((capture) =>
        jsonEquals(capture.scopeId, connection.receipt.nativeScopeId)
    );
    const disposed = observation.disposed || captures.some((capture) => capture.scope === 'disposed') ||
        (captures.length > 0 && event.kind === 'native-observation-status' && event.stage === 'disposed');
    const initialized = event.kind === 'native-observation-status' && event.stage === 'initialized' &&
            captures.some((capture) => capture.scope === 'active') &&
            jsonEquals(event.availability, { status: 'observed', value: 'enabled' })
        ? event
        : observation.initialized;
    return { connectObserved, initialized, disposed, malformedRows: 0 };
}

function toRtcNativeAcquisitionFailure(
    connection: RtcNativeCapturedConnection,
    source: RtcNativeAcquisitionSource | null
): Either<RtcNativeAcquisitionFailure, RtcNativeAcquisitionProof> {
    return Either.ofLeft({
        reason: 'acquisition-failed',
        connection,
        source,
        cause: new Error('RTC Native recorder unavailable.')
    });
}

function toJsonObject(value: ApiJsonValue | undefined): ApiJsonObject | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ApiJsonObject : null;
}

function toNativeAcquisitionCaptures(event: ApiJsonObject): readonly ApiJsonObject[] {
    const service = toJsonObject(event.service);
    return [event, toJsonObject(event.native), toJsonObject(event.candidate), service, toJsonObject(service?.native)]
        .map((body) => toJsonObject(body?.capture))
        .filter((capture) => capture !== null);
}

function matchesAdmittedConnect(row: ApiJsonObject, connection: RtcNativeCapturedConnection): boolean {
    if (connection.recipeAttribution !== undefined) {
        return matchesAdmittedRecipeConnect(row, connection);
    }
    const actual = toJsonObject(row.actual);
    return row.kind === 'step-result' && row.status === 'SUCCESS' && row.action === 'rtc.connect' &&
        row.agentId === connection.agentId && row.commandId === connection.commandId &&
        row.transport === connection.transport && row.connection === connection.connection &&
        actual?.sessionId === connection.sessionId &&
        jsonEquals(actual.rtcCapture, { status: 'observed', value: connection.receipt });
}

function matchesAdmittedRecipeConnect(row: ApiJsonObject, connection: RtcNativeCapturedConnection): boolean {
    const attribution = connection.recipeAttribution;
    if (
        !attribution || typeof attribution !== 'object' ||
        ![attribution.rootCommandId, attribution.recipeId, attribution.invocationId, attribution.recipeBodyId]
            .every((identity) => typeof identity === 'string' && identity.length > 0) ||
        !Number.isSafeInteger(attribution.childIndex) || attribution.childIndex < 0
    ) {
        return false;
    }
    const actual = toJsonObject(row.actual);
    const invocation = toJsonObject(actual?.invocation);
    const evidence = toJsonObject(actual?.resultEvidence);
    if (
        row.kind !== 'step-result' || row.status !== 'SUCCESS' || row.action !== 'recipe.run' ||
        row.agentId !== connection.agentId || row.commandId !== attribution.rootCommandId ||
        row.transport !== 'control' || row.connection !== connection.agentId ||
        actual?.recipeId !== attribution.recipeId || invocation?.invocationId !== attribution.invocationId ||
        invocation.recipeBodyId !== attribution.recipeBodyId ||
        (actual.resultEvidence !== undefined &&
            (evidence?.status !== 'finite' || typeof evidence.payloadsOmitted !== 'boolean')) ||
        !Array.isArray(actual.results)
    ) {
        return false;
    }
    const children = actual.results;
    if (children.filter((child) => toJsonObject(child)?.commandId === connection.commandId).length !== 1) {
        return false;
    }
    const child = toJsonObject(children[attribution.childIndex]);
    const decoded = decodeRallarBlackBoxTestResult(child).right;
    const value = toJsonObject(child?.value);
    return decoded?.kind === 'rtc.connect' && decoded.status === 'ok' && decoded.ok === true &&
        decoded.replayed !== true && decoded.commandId === connection.commandId &&
        value?.transport === connection.transport && value.connection === connection.connection &&
        value.sessionId === connection.sessionId &&
        jsonEquals(value.rtcCapture, { status: 'observed', value: connection.receipt });
}

function toAcquiredNativeProjection(
    row: ApiJsonObject,
    connection: RtcNativeCapturedConnection
): RtcNativeProjection {
    const runtime = toJsonObject(row.value);
    if (
        row.kind !== 'rtc-diagnostic' || row.agentId !== connection.agentId ||
        runtime?.topic !== 'rallar.browser.rtc.signaling_diagnostics'
    ) {
        return { recognized: false, event: undefined };
    }
    const payload = toJsonObject(runtime.payload);
    return toRtcNativeObservationProjection(payload?.data);
}
