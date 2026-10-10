import type { RallarRtcCaptureUnverifiedError } from '@shared-web/browser/connection/rallar-rtc-capture-unverified-error.ts';
import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';
import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

export function toRtcCaptureReadout(
    value: ApiJsonValue | undefined
): Either<
    RallarRtcCaptureUnverifiedError.Reason,
    RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>
> {
    if (value === undefined) {
        return Either.ofRight({ status: 'unavailable', reason: 'absent' });
    }
    const readout = jsonRecord(value);
    if (readout?.status === 'unavailable') {
        return Either.ofRight(
            toRtcCaptureUnavailable(readout) ?? { status: 'unavailable', reason: 'unrecognized' }
        );
    }
    const receipt = readout?.status === 'observed' ? jsonRecord(readout.value) : null;
    if (receipt === null) {
        return Either.ofRight({ status: 'unavailable', reason: 'unrecognized' });
    }
    const configurationVersion = receipt.configurationVersion;
    if (configurationVersion !== 1) {
        return Either.ofLeft('configuration-version-unverified');
    }
    const decoded = toRtcCaptureReceipt(receipt, configurationVersion);
    return Either.ofRight(
        decoded === undefined
            ? { status: 'unavailable', reason: 'unrecognized' }
            : { status: 'observed', value: decoded }
    );
}

function toRtcCaptureReceipt(
    receipt: ApiJsonObject,
    configurationVersion: 1
): RtcSignalingDiagnostics.CaptureReceipt | undefined {
    const configuration = toRtcCaptureConfiguration(receipt.configuration);
    const application = toRtcCaptureApplication(receipt.application);
    const connectionId = toRtcCaptureStringReadout(receipt.connectionId);
    const nativeScopeId = toRtcCaptureStringReadout(receipt.nativeScopeId);
    const nativeAvailability = toRtcCaptureAvailability(receipt.nativeAvailability);
    const nativeCoverage = receipt.nativeCoverage;
    if (
        configuration === undefined || application === undefined || connectionId === undefined ||
        nativeScopeId === undefined ||
        nativeAvailability === undefined ||
        (nativeCoverage !== 'attached' && nativeCoverage !== 'partial' && nativeCoverage !== 'unavailable' &&
            nativeCoverage !== 'not-applicable')
    ) {
        return undefined;
    }
    return {
        configuration,
        application,
        connectionId,
        nativeScopeId,
        configurationVersion,
        nativeAvailability,
        nativeCoverage
    };
}

export function toRtcCaptureConfiguration(
    value: ApiJsonValue | undefined
): RtcSignalingDiagnostics.CaptureConfiguration | undefined {
    const configuration = jsonRecord(value);
    if (configuration === null) {
        return undefined;
    }
    const mode = parseRtcCaptureMode(configuration.mode).right?.mode;
    const origin = configuration.origin;
    return mode !== undefined &&
            (origin === 'run' || origin === 'step' || origin === 'recipe' || origin === 'host' ||
                origin === 'product-default')
        ? { mode, origin }
        : undefined;
}

function toRtcCaptureApplication(
    value: ApiJsonValue | undefined
): RtcSignalingDiagnostics.CaptureApplication | undefined {
    const application = jsonRecord(value);
    if (application?.status === 'applied') {
        const mode = parseRtcCaptureMode(application.mode).right?.mode;
        return mode === undefined ? undefined : { status: 'applied', mode };
    }
    const reason = application?.reason;
    return application?.status === 'unavailable' &&
            (reason === 'sink-unavailable' || reason === 'unsupported' || reason === 'initialization-failed')
        ? { status: 'unavailable', reason }
        : undefined;
}

function toRtcCaptureStringReadout(
    value: ApiJsonValue | undefined
): RtcSignalingDiagnostics.Readout<string> | undefined {
    const readout = jsonRecord(value);
    return readout?.status === 'observed' && typeof readout.value === 'string'
        ? { status: 'observed', value: readout.value }
        : toRtcCaptureUnavailable(value);
}

function toRtcCaptureAvailability(
    value: ApiJsonValue | undefined
): RtcSignalingDiagnostics.Readout<'enabled'> | undefined {
    const readout = jsonRecord(value);
    return readout?.status === 'observed' && readout.value === 'enabled'
        ? { status: 'observed', value: 'enabled' }
        : toRtcCaptureUnavailable(value);
}

function toRtcCaptureUnavailable(
    value: ApiJsonValue | undefined
): RtcSignalingDiagnostics.UnavailableReadout | undefined {
    const readout = jsonRecord(value);
    if (readout?.status !== 'unavailable') {
        return undefined;
    }
    const reason = readout.reason;
    switch (reason) {
        case 'disabled':
        case 'no-native-object':
        case 'absent':
        case 'unsupported':
        case 'unrecognized':
        case 'read-failed':
        case 'identity-source-absent':
        case 'identity-source-failed':
        case 'identity-invalid':
        case 'initialization-failed':
        case 'admission-limit':
        case 'scope-disposed':
        case 'payload-bytes':
        case 'not-applicable':
            return { status: 'unavailable', reason };
        default:
            return undefined;
    }
}

function jsonRecord(value: ApiJsonValue | undefined): ApiJsonObject | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ApiJsonObject : null;
}
