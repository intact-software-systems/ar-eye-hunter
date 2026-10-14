import { parseRtcCaptureMode, resolveRtcCaptureConfiguration } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import type { RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';

export interface RtcBaselineCaptureAdmission {
    readonly mode: RtcSignalingDiagnostics.CaptureMode;
    readonly source: 'cli' | 'environment' | 'default';
}

export const RTC_BASELINE_CAPTURE_ENVIRONMENT_NAME = 'RALLAR_BLACK_BOX_RTC_CAPTURE_MODE';

export function resolveRtcBaselineCaptureAdmission(
    cliMode: RtcSignalingDiagnostics.CaptureMode | undefined,
    environmentValue: string | undefined
): RtcBaselineResult<RtcBaselineCaptureAdmission> {
    const environment = parseRtcCaptureMode(cliMode === undefined ? environmentValue : undefined);
    if (environment.left !== undefined) {
        return {
            ok: false,
            issues: (environment.left ?? []).map((issue) => ({
                ...issue,
                path: `$.${RTC_BASELINE_CAPTURE_ENVIRONMENT_NAME}`
            }))
        };
    }
    const selected = resolveRtcCaptureConfiguration({
        run: cliMode,
        host: environment.right?.mode,
        sinkAvailable: true
    });
    return {
        ok: true,
        value: Object.freeze({
            mode: selected.mode,
            source: selected.origin === 'run' ? 'cli' : selected.origin === 'host' ? 'environment' : 'default'
        })
    };
}
