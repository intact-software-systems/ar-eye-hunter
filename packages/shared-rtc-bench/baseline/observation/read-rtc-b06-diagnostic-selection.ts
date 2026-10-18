import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import {
    validateEventHistoryPolicy,
    type RallarBlackBoxEventHistoryPolicy
} from '../../../shared-test/rallar-bb-test/runtime/event-history.ts';

import {
    toRallarBlackBoxRoutineBrowserDiagnostics,
    type RallarBlackBoxRoutineBrowserDiagnostics
} from '../../../shared-test/black-box-runner/fixtures/browser-diagnostics-recording.ts';

import { RTC_BASELINE_WORKLOAD_CATALOG } from '../catalog/rtc-baseline-workload-catalog.ts';
import { decodeRtcBaselineEnvironment } from '../contracts/rtc-baseline-artifact-decoding.ts';
import type {
    RtcBaselineAttemptLocatorDto,
    RtcBaselineCaseKeyDto,
    RtcBaselineResolvedConfigurationValueDto,
    RtcBaselineResult
} from '../contracts/rtc-baseline-contracts.ts';
import { resolveRtcBaselineConfiguration } from '../contracts/rtc-baseline-validation.ts';
import type { RtcBaselineFileStore } from '../evidence/rtc-baseline-evidence-store.ts';

export interface RtcB06DiagnosticSelection {
    readonly rtcCaptureMode: RtcSignalingDiagnostics.CaptureMode;
    readonly eventHistory: RallarBlackBoxEventHistoryPolicy;
    readonly almDiagnostics: boolean;
    readonly releaseResultsAfterCapture: boolean;
    readonly routineBrowserDiagnostics: RallarBlackBoxRoutineBrowserDiagnostics;
}

export function resolveRtcB06ReleaseEnvironment(
    caseKey: RtcBaselineCaseKeyDto,
    raw: string | undefined
): RtcBaselineResult<RtcBaselineResolvedConfigurationValueDto> {
    const descriptor = RTC_BASELINE_WORKLOAD_CATALOG.find((entry) => entry.workloadId === caseKey.workloadId)?.cases
        .find((entry) => entry.caseId === caseKey.caseId && entry.inputKey === caseKey.inputKey)?.configuration
        .find((entry) => entry.field === 'releaseResultsAfterCapture');
    return descriptor === undefined
        ? {
            ok: false,
            issues: [{
                path: '$.resultRelease',
                code: 'invalid-result-release-selection',
                message: 'Release requires an exact B06 case descriptor.'
            }]
        }
        : resolveRtcBaselineConfiguration(descriptor, { cliValue: undefined, environmentValue: raw });
}

export function resolveRtcB06DiagnosticSelection(
    configuration: readonly RtcBaselineResolvedConfigurationValueDto[],
    caseKey: RtcBaselineCaseKeyDto
): RtcBaselineResult<RtcB06DiagnosticSelection> {
    const selected = configuration.filter((entry) =>
        entry.caseKey.workloadId === caseKey.workloadId &&
        entry.caseKey.caseId === caseKey.caseId && entry.caseKey.inputKey === caseKey.inputKey
    );
    const alm = selected.filter((entry) => entry.field === 'almDiagnostics');
    if (alm.length !== 1 || typeof alm[0]?.value !== 'boolean') {
        return {
            ok: false,
            issues: [{
                path: '$.resolvedConfiguration',
                code: 'missing-alm-selection',
                message: 'RTC-B06 requires one initialized ALM boolean for its exact case and input.'
            }]
        };
    }
    const recording = resolveRtcB06RecordingSelection(selected, caseKey);
    if (!recording.ok) {
        return recording;
    }
    const history = resolveRtcB06EventHistorySelection(selected);
    if (!history.ok) {
        return history;
    }

    const capture = resolveRtcB06CaptureMode(selected);
    if (!capture.ok) {
        return capture;
    }
    const release = selected.filter((entry) => entry.field === 'releaseResultsAfterCapture');
    if (
        release.length !== 1 || typeof release[0]?.value !== 'boolean' ||
        (caseKey.caseId !== 'retention-100' && release[0].value)
    ) {
        return {
            ok: false,
            issues: [{
                path: '$.resolvedConfiguration',
                code: 'invalid-result-release-selection',
                message: 'RTC-B06 requires one initialized release boolean; only retention may select release.'
            }]
        };
    }
    return {
        ok: true,
        value: {
            rtcCaptureMode: capture.value,
            eventHistory: history.value,
            almDiagnostics: alm[0].value,
            releaseResultsAfterCapture: release[0].value,
            routineBrowserDiagnostics: recording.value
        }
    };
}

export async function readRtcB06DiagnosticSelection(
    store: Pick<RtcBaselineFileStore, 'readJson'>,
    baselineId: string,
    attempt: RtcBaselineAttemptLocatorDto
): Promise<RtcBaselineResult<RtcB06DiagnosticSelection>> {
    const raw = await store.readJson(baselineId, 'environment.json');
    if (!raw.ok) {
        return raw;
    }
    const environment = decodeRtcBaselineEnvironment(raw.value);
    if (!environment.ok) {
        return environment;
    }
    if (environment.value.baselineId !== baselineId || environment.value.environmentId !== attempt.environmentId) {
        return {
            ok: false,
            issues: [{
                path: '$.resolvedConfiguration',
                code: 'missing-alm-selection',
                message: 'RTC-B06 diagnostic selection must belong to the exact initialized baseline and environment.'
            }]
        };
    }
    const configuration = environment.value.observation?.resolvedConfiguration ?? [];
    if (attempt.environmentId === 'E4-pg') {
        const fields = configuration.filter((entry) =>
            entry.caseKey.workloadId === attempt.workloadId &&
            entry.caseKey.caseId === attempt.caseId && entry.caseKey.inputKey === attempt.inputKey
        );
        if (
            fields.filter((entry) => entry.field === 'databaseProvider' && entry.value === 'postgres').length !== 1 ||
            fields.filter((entry) => entry.field === 'iceMode' && entry.value === 'local').length !== 1
        ) {
            return {
                ok: false,
                issues: [{
                    path: '$.resolvedConfiguration',
                    code: 'invalid-e4-producer-configuration',
                    message:
                        'E4-pg requires initialized PostgreSQL provider and local ICE for its exact case and input.'
                }]
            };
        }
    }
    return resolveRtcB06DiagnosticSelection(configuration, attempt);
}

function resolveRtcB06EventHistorySelection(
    selected: readonly RtcBaselineResolvedConfigurationValueDto[]
): RtcBaselineResult<RallarBlackBoxEventHistoryPolicy> {
    const historyMode = selected.filter((entry) => entry.field === 'eventHistoryMode');
    const historyBound = selected.filter((entry) => entry.field === 'eventHistoryMaxEvents');
    const eventHistory = historyMode[0]?.value === 'full'
        ? { mode: 'full' as const }
        : { mode: historyMode[0]?.value, maxEvents: historyBound[0]?.value };
    if (
        historyMode.length !== 1 || historyBound.length !== 1 || validateEventHistoryPolicy(eventHistory).length > 0 ||
        (historyMode[0]?.value === 'full' && historyBound[0]?.value !== 0)
    ) {
        return {
            ok: false,
            issues: [{
                path: '$.resolvedConfiguration',
                code: 'invalid-event-history-selection',
                message: 'RTC-B06 requires one complete initialized canonical event history policy for its exact case.'
            }]
        };
    }
    return { ok: true, value: Object.freeze(eventHistory as RallarBlackBoxEventHistoryPolicy) };
}

function resolveRtcB06CaptureMode(
    selected: readonly RtcBaselineResolvedConfigurationValueDto[]
): RtcBaselineResult<RtcSignalingDiagnostics.CaptureMode> {
    const capture = selected.filter((entry) => entry.field === 'rtcCaptureMode');
    if (capture.length !== 1) {
        return {
            ok: false,
            issues: [{
                path: '$.resolvedConfiguration',
                code: 'missing-capture-admission',
                message: 'RTC-B06 requires one initialized RTC capture mode for its exact case.'
            }]
        };
    }
    const mode = parseRtcCaptureMode(capture[0].value).right?.mode;
    if (mode === undefined) {
        return {
            ok: false,
            issues: [{
                path: '$.resolvedConfiguration',
                code: 'invalid-rtc-capture-mode',
                message: 'Initialized RTC capture mode must be off, signaling or native.'
            }]
        };
    }
    return { ok: true, value: mode };
}

function resolveRtcB06RecordingSelection(
    selected: readonly RtcBaselineResolvedConfigurationValueDto[],
    caseKey: RtcBaselineCaseKeyDto
): RtcBaselineResult<RallarBlackBoxRoutineBrowserDiagnostics> {
    const recording = selected.filter((entry) => entry.field === 'routineBrowserDiagnostics');
    const routineBrowserDiagnostics = typeof recording[0]?.value === 'string'
        ? toRallarBlackBoxRoutineBrowserDiagnostics(recording[0].value)
        : undefined;
    if (
        recording.length !== 1 || routineBrowserDiagnostics === undefined ||
        (caseKey.caseId !== 'retention-100' && routineBrowserDiagnostics !== 'enabled')
    ) {
        return {
            ok: false,
            issues: [{
                path: '$.resolvedConfiguration',
                code: 'invalid-routine-recording-selection',
                message:
                    'RTC-B06 requires one initialized enabled/disabled recording selection; non-retention cases require enabled.'
            }]
        };
    }
    return { ok: true, value: routineBrowserDiagnostics };
}
