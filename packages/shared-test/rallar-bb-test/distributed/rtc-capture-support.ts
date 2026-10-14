import { Either } from '@shared/resilience/Either.ts';
import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import type { RallarBlackBoxRtcCaptureSupport } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

export interface ParsedRtcCaptureSupport {
    readonly support: RallarBlackBoxRtcCaptureSupport | undefined;
}

/** Absence means no installed support. Present advertisements must be finite and compatible. */
export function decodeRtcCaptureSupport(value: unknown): Either<string, ParsedRtcCaptureSupport> {
    if (value === undefined) {
        return Either.ofRight({ support: undefined });
    }
    if (!isJsonRecordValue(value) || value.configurationVersion !== 1 || !Array.isArray(value.modes)) {
        return Either.ofLeft('rtcCapture must report configurationVersion 1 and a finite modes array');
    }
    const modes: RtcSignalingDiagnostics.CaptureMode[] = [];
    for (const valueMode of value.modes) {
        const parsed = parseRtcCaptureMode(valueMode);
        if (parsed.left || parsed.right?.mode === undefined || modes.includes(parsed.right.mode)) {
            return Either.ofLeft('rtcCapture.modes must list unique off, signaling or native modes');
        }
        modes.push(parsed.right.mode);
    }
    return Either.ofRight({ support: Object.freeze({ configurationVersion: 1, modes: Object.freeze(modes) }) });
}

/** The requirement is executable intent; support does not prove application or current Native API availability. */
export function toMissingRtcCaptureSupportReason(
    required: readonly RtcSignalingDiagnostics.CaptureMode[],
    support: RallarBlackBoxRtcCaptureSupport | undefined
): string | undefined {
    if (required.length === 0) {
        return undefined;
    }
    const decoded = decodeRtcCaptureSupport(support);
    const missing = required.filter((mode) => !decoded.right?.support?.modes.includes(mode));
    return decoded.left || missing.length > 0
        ? `Agent does not advertise required RTC capture support (configurationVersion 1): ${
            decoded.left ?? missing.join(', ')
        }.`
        : undefined;
}
