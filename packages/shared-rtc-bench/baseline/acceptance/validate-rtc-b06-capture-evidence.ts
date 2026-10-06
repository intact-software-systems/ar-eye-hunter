import { resolveRequiredRtcCaptureFailure } from '@shared-web/browser/connection/browser-rtc-capture-intent.ts';
import {
    toRtcCaptureConfiguration,
    toRtcCaptureReadout
} from '@shared-web/browser/connection/to-rtc-capture-readout.ts';
import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';

import type {
    RtcBaselineIssueDto,
    RtcBaselineResolvedConfigurationValueDto,
    RtcBaselineSampleDto
} from '../contracts/rtc-baseline-contracts.ts';

export function validateRtcB06CaptureEvidence(
    sample: RtcBaselineSampleDto,
    initializedConfiguration: readonly RtcBaselineResolvedConfigurationValueDto[]
): readonly RtcBaselineIssueDto[] {
    const selected = initializedConfiguration.find((entry) =>
        entry.field === 'rtcCaptureMode' &&
        entry.caseKey.workloadId === sample.identity.workloadId && entry.caseKey.caseId === sample.identity.caseId &&
        entry.caseKey.inputKey === sample.identity.inputKey
    );
    if (selected === undefined) {
        return [{
            path: '$.resolvedConfiguration',
            code: 'missing-capture-admission',
            message: 'New RTC-B06 samples require an initialized capture mode for their exact case and input.'
        }];
    }
    const mode = parseRtcCaptureMode(selected.value).right?.mode;
    if (mode === undefined) {
        return [captureIssue('invalid-rtc-capture-mode')];
    }
    const raw = sample.rawEvidence;
    const captures = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? raw.rtcConnectCaptures
        : undefined;
    if (!Array.isArray(captures) || captures.length === 0) {
        return [captureIssue('receipt-unavailable')];
    }
    return captures.flatMap((capture) => {
        if (typeof capture !== 'object' || capture === null || Array.isArray(capture)) {
            return [captureIssue('invalid-capture-record')];
        }
        const hasAttribution = ['runId', 'agentId', 'commandId', 'connection', 'sessionId'].every((field) => {
            const value = capture[field];
            return typeof value === 'string' && value.length > 0;
        });
        const requested = toRtcCaptureConfiguration(capture.requestedConfiguration);
        if (
            !hasAttribution || (capture.transport !== 'realtime' && capture.transport !== 'messages.rtc') ||
            requested === undefined
        ) {
            return [captureIssue('invalid-capture-record')];
        }
        if (requested.mode !== mode) {
            return [captureIssue('mode-mismatch')];
        }
        const receipt = capture.receipt;
        const decoded = toRtcCaptureReadout(receipt === undefined ? undefined : { status: 'observed', value: receipt });
        const reason = decoded.left ?? (decoded.right === undefined
            ? 'receipt-unavailable'
            : resolveRequiredRtcCaptureFailure(requested, decoded.right));
        return reason === undefined ? [] : [captureIssue(reason)];
    });
}

function captureIssue(code: string): RtcBaselineIssueDto {
    return {
        path: '$.rawEvidence.rtcConnectCaptures',
        code,
        message: `Completed Connect receipts do not prove the selected RTC capture mode: ${code}.`
    };
}
