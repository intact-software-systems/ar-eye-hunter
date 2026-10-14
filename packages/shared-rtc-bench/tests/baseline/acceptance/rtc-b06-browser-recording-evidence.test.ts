import { expect, it } from 'vitest';

import { validateRtcB06CaptureEvidence } from '../../../baseline/acceptance/validate-rtc-b06-capture-evidence.ts';
import type { RtcBaselineResolvedConfigurationValueDto, RtcBaselineSampleDto } from '../../../baseline/contracts/rtc-baseline-contracts.ts';

const caseKey = { workloadId: 'RTC-B06', caseId: 'retention-100', inputKey: 'e3-memory-retention-100' } as const;
const configuration: readonly RtcBaselineResolvedConfigurationValueDto[] = [
    { caseKey, field: 'eventHistoryMode', value: 'recent', source: 'default' },
    { caseKey, field: 'eventHistoryMaxEvents', value: 64, source: 'default' },
    { caseKey, field: 'rtcCaptureMode', value: 'off', source: 'cli' },
    { caseKey, field: 'almDiagnostics', value: false, source: 'environment' },
    { caseKey, field: 'routineBrowserDiagnostics', value: 'disabled', source: 'environment' }
];
function receipt(count: number) {
    return { routineBrowserDiagnostics: 'disabled', omittedRoutineBrowserDiagnostics: count, forwardedBrowserDiagnostics: count };
}
function agentEvidence(agentId: string, cycle: number) {
    return {
        agentId,
        details: {
            eventHistory: history(agentId, cycle + 2),
            browserDiagnostics: receipt(cycle + 2),
            browserDiagnosticsAdmission: { runId: 'run', agentId, commandId: `admit-${agentId}`, receipt: receipt(1), eventHistory: history(agentId, 1) },
            browserDiagnosticsHealth: { runId: 'run', agentId, commandId: `health-${agentId}-${cycle}` }
        }
    };
}
function candidate() {
    const checkpoints = Array.from(
        { length: 11 },
        (_, index) => ({ cycle: index * 10, agents: ['a', 'b', 'c'].map((agentId) => agentEvidence(agentId, index * 10)) })
    );
    return {
        schema: 'rallar.rtc-baseline.sample.v1',
        identity: { ...caseKey, sampleId: 'sample', intendedPhase: 'retained', outerOrdinal: 1, innerOrdinal: 1 },
        outcome: 'passed',
        evidenceClass: 'local-full-stack',
        metrics: [],
        rawReferences: [],
        issues: [],
        runtimeObservation: null,
        rawEvidence: {
            diagnostics: checkpoints,
            retention: { checkpoints },
            rtcConnectCaptures: ['a', 'b', 'c'].map((agentId) => ({
                runId: 'run',
                agentId,
                commandId: `connect-${agentId}`,
                connection: agentId,
                sessionId: agentId,
                transport: 'realtime',
                almDiagnostics: false,
                requestedConfiguration: { mode: 'off', origin: 'step' },
                receipt: {
                    configuration: { mode: 'off', origin: 'step' },
                    application: { status: 'applied', mode: 'off' },
                    configurationVersion: 1,
                    connectionId: { status: 'observed', value: agentId },
                    nativeScopeId: { status: 'unavailable', reason: 'not-applicable' },
                    nativeAvailability: { status: 'unavailable', reason: 'disabled' },
                    nativeCoverage: 'not-applicable'
                }
            }))
        }
    } satisfies RtcBaselineSampleDto;
}
it('accepts actual attributed same-lifetime recording receipts at every existing checkpoint', () => {
    expect(validateRtcB06CaptureEvidence(candidate(), configuration)).toEqual([]);
});
it.each([
    'request-only',
    'wrong-agent',
    'wrong-run',
    'duplicate-agent',
    'mixed-mode',
    'decreasing',
    'fractional',
    'incomplete',
    'no-omission',
    'changed-lifetime',
    'duplicate-admission-command'
])('rejects %s recording evidence', (failure) => {
    const sample = candidate();
    const raw = structuredClone(sample.rawEvidence);
    const final = raw.retention.checkpoints[10].agents;
    if (failure === 'duplicate-admission-command') {
        for (const checkpoint of [...raw.diagnostics, ...raw.retention.checkpoints]) {
            for (const agent of checkpoint.agents) {
                agent.details.browserDiagnosticsAdmission.commandId = 'same-command';
            }
        }
    }
    if (failure === 'request-only') {
        Reflect.deleteProperty(raw, 'diagnostics');
        Reflect.deleteProperty(raw, 'retention');
        Object.assign(raw, { routineBrowserDiagnostics: 'disabled' });
    }
    if (failure === 'wrong-agent') {
        final[2].details.browserDiagnosticsHealth.agentId = 'a';
    }
    if (failure === 'wrong-run') {
        final[2].details.browserDiagnosticsAdmission.runId = 'other';
    }
    if (failure === 'duplicate-agent') {
        final[2] = final[0];
    }
    if (failure === 'mixed-mode') {
        final[2].details.browserDiagnostics.routineBrowserDiagnostics = 'enabled';
    }
    if (failure === 'decreasing') {
        final[2].details.browserDiagnostics.forwardedBrowserDiagnostics = 0;
    }
    if (failure === 'fractional') {
        final[2].details.browserDiagnostics.omittedRoutineBrowserDiagnostics = 1.5;
    }
    if (failure === 'incomplete') {
        raw.retention.checkpoints.splice(5, 1);
    }
    if (failure === 'changed-lifetime') {
        final[2].details.browserDiagnosticsAdmission.commandId = 'another-page';
    }
    if (failure === 'no-omission') {
        for (const checkpoint of [...raw.diagnostics, ...raw.retention.checkpoints]) {
            for (const agent of checkpoint.agents) {
                agent.details.browserDiagnostics.omittedRoutineBrowserDiagnostics = 0;
                agent.details.browserDiagnosticsAdmission.receipt.omittedRoutineBrowserDiagnostics = 0;
            }
        }
    }
    expect(validateRtcB06CaptureEvidence({ ...sample, rawEvidence: raw }, configuration).length).toBeGreaterThan(0);
});

function history(agentId: string, totalEvents: number) {
    return {
        runtimeId: `runtime-${agentId}`,
        generation: 0,
        policy: { mode: 'recent', maxEvents: 64 },
        totalEvents,
        retainedEvents: Math.min(totalEvents, 64),
        evictedEvents: Math.max(0, totalEvents - 64),
        evictedThroughEpochMs: totalEvents > 64 ? totalEvents : null,
        countsByKind: { event: totalEvents, diagnostic: 0, message: 0, stats: 0, report: 0, result: 0, state: 0 },
        reconnects: 0,
        capture: { status: 'continuous', identity: { runId: 'run', agentId }, start: { runtimeId: `runtime-${agentId}`, generation: 0, ordinal: 1 } }
    };
}

it.each([
    'missing',
    'full',
    'wrong-bound',
    'substituted-runtime',
    'generation',
    'capture-gap',
    'capture-agent',
    'capture-run',
    'accounting',
    'fractional',
    'decreasing',
    'shared-runtime',
    'stale'
])('refuses %s actual event-history evidence', (failure) => {
    const sample = candidate();
    const raw = structuredClone(sample.rawEvidence);
    for (const checkpoint of [raw.diagnostics[10], raw.retention.checkpoints[10]]) {
        const current = checkpoint.agents[2].details.eventHistory;
        if (failure === 'missing') {
            Reflect.deleteProperty(checkpoint.agents[2].details, 'eventHistory');
        }
        if (failure === 'full') {
            Object.assign(current, { policy: { mode: 'full' } });
        }
        if (failure === 'wrong-bound') {
            current.policy.maxEvents = 65;
        }
        if (failure === 'substituted-runtime') {
            current.runtimeId = 'replacement';
        }
        if (failure === 'generation') {
            current.generation = 1;
        }
        if (failure === 'capture-gap') {
            current.capture.status = 'gap';
        }
        if (failure === 'capture-agent') {
            current.capture.identity.agentId = 'a';
        }
        if (failure === 'capture-run') {
            current.capture.identity.runId = 'other';
        }
        if (failure === 'accounting') {
            current.evictedEvents++;
        }
        if (failure === 'fractional') {
            current.totalEvents = 100.5;
        }
        if (failure === 'decreasing') {
            current.countsByKind.event = 0;
        }
        if (failure === 'shared-runtime') {
            Object.assign(current, history('a', 102));
            current.capture.identity.agentId = 'c';
        }
        if (failure === 'stale') {
            Object.assign(current, history('c', 1));
        }
    }
    expect(validateRtcB06CaptureEvidence({ ...sample, rawEvidence: raw }, configuration).length).toBeGreaterThan(0);
});
