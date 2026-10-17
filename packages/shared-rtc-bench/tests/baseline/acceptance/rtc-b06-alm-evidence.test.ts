import { expect, it } from 'vitest';

import { validateRtcB06CaptureEvidence } from '../../../baseline/acceptance/validate-rtc-b06-capture-evidence.ts';
import type { RtcBaselineResolvedConfigurationValueDto, RtcBaselineSampleDto } from '../../../baseline/contracts/rtc-baseline-contracts.ts';

const caseKey = { workloadId: 'RTC-B06', caseId: 'retention-100', inputKey: 'e3-memory-retention-100' } as const;
const configuration: readonly RtcBaselineResolvedConfigurationValueDto[] = [
    { caseKey, field: 'eventHistoryMode', value: 'full', source: 'default' },
    { caseKey, field: 'eventHistoryMaxEvents', value: 0, source: 'default' },
    { caseKey, field: 'releaseResultsAfterCapture', value: false, source: 'default' },
    { caseKey, field: 'rtcCaptureMode', value: 'off', source: 'cli' },
    { caseKey, field: 'almDiagnostics', value: false, source: 'environment' },
    { caseKey, field: 'routineBrowserDiagnostics', value: 'enabled', source: 'default' }
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
        rawEvidence: {
            resultRelease: { raw: null, enabled: false, status: 'verified', releasedRoots: 0, sources: [] },
            rtcConnectCaptures: ['a', 'b', 'c'].map((agentId) => ({ ...capture, agentId, ...(almDiagnostics === undefined ? {} : { almDiagnostics }) })),
            diagnostics: recordingCheckpoints(),
            retention: { checkpoints: recordingCheckpoints() }
        },
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
    expect(validateRtcB06CaptureEvidence(sample(false), configuration.filter((entry) => entry.field === 'rtcCaptureMode'))).toMatchObject([{
        code: 'missing-alm-selection'
    }]);
});

function recordingCheckpoints() {
    const receipt = { routineBrowserDiagnostics: 'enabled', omittedRoutineBrowserDiagnostics: 0, forwardedBrowserDiagnostics: 0 };
    return Array.from({ length: 11 }, (_, index) => ({
        cycle: index * 10,
        agents: ['a', 'b', 'c'].map((agentId) => ({
            agentId,
            details: {
                eventHistory: eventHistory(agentId, index + 2, 'run'),
                browserDiagnostics: receipt,
                browserDiagnosticsAdmission: { runId: 'run', agentId, commandId: `admit-${agentId}`, receipt, eventHistory: eventHistory(agentId, 1, 'run') },
                browserDiagnosticsHealth: { runId: 'run', agentId, commandId: `health-${agentId}-${index}` }
            }
        }))
    }));
}

function eventHistory(agentId: string, totalEvents: number, runId: string) {
    return {
        runtimeId: `runtime-${agentId}`,
        generation: 0,
        policy: { mode: 'full' },
        totalEvents,
        retainedEvents: totalEvents,
        evictedEvents: 0,
        evictedThroughEpochMs: null,
        countsByKind: { event: totalEvents, diagnostic: 0, message: 0, stats: 0, report: 0, result: 0, state: 0 },
        reconnects: 0,
        capture: { status: 'continuous', identity: { runId, agentId }, start: { runtimeId: `runtime-${agentId}`, generation: 0, ordinal: 1 } }
    };
}
