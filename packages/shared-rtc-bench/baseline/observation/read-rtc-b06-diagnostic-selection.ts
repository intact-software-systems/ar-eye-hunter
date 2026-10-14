import {
    validateEventHistoryPolicy,
    type RallarBlackBoxEventHistoryPolicy
} from '../../../shared-test/rallar-bb-test/runtime/event-history.ts';

import {
    toRallarBlackBoxRoutineBrowserDiagnostics,
    type RallarBlackBoxRoutineBrowserDiagnostics
} from '../../../shared-test/black-box-runner/fixtures/browser-diagnostics-recording.ts';

import { decodeRtcBaselineEnvironment } from '../contracts/rtc-baseline-artifact-decoding.ts';
import type {
    RtcBaselineAttemptLocatorDto,
    RtcBaselineCaseKeyDto,
    RtcBaselineResolvedConfigurationValueDto,
    RtcBaselineResult
} from '../contracts/rtc-baseline-contracts.ts';
import type { RtcBaselineFileStore } from '../evidence/rtc-baseline-evidence-store.ts';

export interface RtcB06DiagnosticSelection {
    readonly eventHistory: RallarBlackBoxEventHistoryPolicy;
    readonly almDiagnostics: boolean;
    readonly routineBrowserDiagnostics: RallarBlackBoxRoutineBrowserDiagnostics;
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
    const recording = selected.filter((entry) => entry.field === 'routineBrowserDiagnostics');
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
    const history = resolveRtcB06EventHistorySelection(selected);
    if (!history.ok) {
        return history;
    }

    return {
        ok: true,
        value: {
            eventHistory: history.value,
            almDiagnostics: alm[0].value,
            routineBrowserDiagnostics
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
    return resolveRtcB06DiagnosticSelection(environment.value.observation?.resolvedConfiguration ?? [], attempt);
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
