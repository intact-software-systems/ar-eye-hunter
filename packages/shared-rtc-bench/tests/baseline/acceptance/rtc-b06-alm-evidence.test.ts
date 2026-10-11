import { expect, it } from 'vitest';

import { validateRtcB06CaptureEvidence } from '../../../baseline/acceptance/validate-rtc-b06-capture-evidence.ts';
import type { RtcBaselineResolvedConfigurationValueDto, RtcBaselineSampleDto } from '../../../baseline/contracts/rtc-baseline-contracts.ts';

const caseKey = { workloadId: 'RTC-B06', caseId: 'retention-100', inputKey: 'e3-memory-retention-100' } as const;
const configuration: readonly RtcBaselineResolvedConfigurationValueDto[] = [
    { caseKey, field: 'rtcCaptureMode', value: 'off', source: 'cli' },
    { caseKey, field: 'almDiagnostics', value: false, source: 'environment' }
];
const capture = {
    runId: 'run',
    agentId: 'c',
    commandId: 'connect-c-100',
    connection: 'connection-c',
    sessionId: 'session-c',
    transport: 'realtime',
    requestedConfiguration: { mode: 'off', origin: 'step' },
    receipt: {
        configuration: { mode: 'off', origin: 'step' },
        application: { status: 'applied', mode: 'off' },
        configurationVersion: 1,
        connectionId: { status: 'observed', value: 'connection-c' },
        nativeScopeId: { status: 'unavailable', reason: 'not-applicable' },
        nativeAvailability: { status: 'unavailable', reason: 'disabled' },
        nativeCoverage: 'not-applicable'
    }
} as const;
function sample(almDiagnostics: boolean | undefined): RtcBaselineSampleDto {
    return {
        schema: 'rallar.rtc-baseline.sample.v1',
        identity: { ...caseKey, sampleId: 'sample', intendedPhase: 'retained', outerOrdinal: 1, innerOrdinal: 1 },
        outcome: 'passed',
        evidenceClass: 'local-full-stack',
        metrics: [],
        rawEvidence: { rtcConnectCaptures: [{ ...capture, ...(almDiagnostics === undefined ? {} : { almDiagnostics }) }] },
        rawReferences: [],
        issues: [],
        runtimeObservation: null
    };
}
it('accepts the per-connect applied Off value under its exact case identity', () => {
    expect(validateRtcB06CaptureEvidence(sample(false), configuration)).toEqual([]);
});
it.each([undefined, true])('refuses absent or contradictory applied policy %s', (almDiagnostics) => {
    expect(validateRtcB06CaptureEvidence(sample(almDiagnostics), configuration)).toMatchObject([
        { code: 'alm-policy-unverified', path: '$.rawEvidence.rtcConnectCaptures' }
    ]);
});
it('refuses a missing initialized ALM selection', () => {
    expect(validateRtcB06CaptureEvidence(sample(false), configuration.slice(0, 1))).toMatchObject([{ code: 'missing-alm-selection' }]);
});
