import { decodeRtcBaselineEnvironment } from '../contracts/rtc-baseline-artifact-decoding.ts';
import type { RtcBaselineAttemptLocatorDto, RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import type { RtcBaselineFileStore } from '../evidence/rtc-baseline-evidence-store.ts';

export async function readRtcB06AlmSelection(
    store: Pick<RtcBaselineFileStore, 'readJson'>,
    baselineId: string,
    attempt: RtcBaselineAttemptLocatorDto
): Promise<RtcBaselineResult<boolean>> {
    const raw = await store.readJson(baselineId, 'environment.json');
    if (!raw.ok) {
        return raw;
    }
    const environment = decodeRtcBaselineEnvironment(raw.value);
    if (!environment.ok) {
        return environment;
    }
    const selected = environment.value.observation?.resolvedConfiguration.filter((entry) =>
        entry.field === 'almDiagnostics' && entry.caseKey.workloadId === attempt.workloadId &&
        entry.caseKey.caseId === attempt.caseId && entry.caseKey.inputKey === attempt.inputKey
    );
    const value = selected?.[0]?.value;
    return environment.value.baselineId === baselineId && environment.value.environmentId === attempt.environmentId &&
            selected?.length === 1 && typeof value === 'boolean'
        ? { ok: true, value }
        : {
            ok: false,
            issues: [{
                path: '$.resolvedConfiguration',
                code: 'missing-alm-selection',
                message: 'RTC-B06 producer requires the initialized ALM boolean for its exact baseline, case and input.'
            }]
        };
}
