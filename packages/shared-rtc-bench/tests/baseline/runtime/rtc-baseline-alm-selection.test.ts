import { describe, expect, it } from 'vitest';

import type { RtcBaselineCaptureRequestDto, RtcBaselineRuntimeObservationDto } from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import { createRtcBaselineRuntimeObservationInput } from '../../../baseline/runtime/create-rtc-baseline-runtime-observation-input.ts';

const request: RtcBaselineCaptureRequestDto = {
    schema: 'rallar.rtc-baseline.capture-request.v1',
    baselineId: '20260816-956a057c9ab5-e3-memory',
    workloadIds: ['RTC-B06'],
    environmentId: 'E3-memory',
    retainedSampleMultiplier: 1,
    repeatLink: null,
    conditionalEnvironmentDecisions: []
};
const governedEnvironment = {
    RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1',
    RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
    RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100'
};

describe('RTC baseline ALM recording selection', () => {
    it.each([[undefined, true, 'default'], ['true', true, 'environment'], ['false', false, 'environment']] as const)(
        'resolves %s with truthful per-case policy and source',
        (value, expected, source) => {
            const result = createRtcBaselineRuntimeObservationInput(request, {
                ...governedEnvironment,
                ...(value === undefined ? {} : { RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: value })
            });
            expect(result.ok).toBe(true);
            if (!result.ok) {
                return;
            }
            expect(
                result.value.observation.resolvedConfiguration.filter((entry) => entry.field === 'almDiagnostics').map((
                    entry
                ) => [entry.caseKey.caseId, entry.value, entry.source])
            ).toEqual([
                ['default', true, 'default'],
                ['all-scenarios', true, 'default'],
                ['retention-100', expected, source]
            ]);
            const restored = createRtcBaselineRuntimeObservationInput(request, {
                ...governedEnvironment,
                RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: 'invalid-after-initialization'
            }, {
                initialized: {
                    ...result.value.observation,
                    git: { headCommit: 'a'.repeat(40), headTree: 'b'.repeat(40), ref: 'feature', clean: true },
                    runtime: { node: '24', npm: '11', deno: '2', playwright: '1', chromium: '1' },
                    host: {
                        os: 'test',
                        kernel: 'test',
                        architecture: 'test',
                        logicalCpuCount: 1,
                        cpuModel: 'test',
                        totalMemoryBytes: 1,
                        executionContext: 'local'
                    },
                    timing: { startedAtUtc: '2026-08-16T10:00:00Z', endedAtUtc: '2026-08-16T10:00:00Z', monotonicDurationMs: 0, monotonicSource: 'test' },
                    sourceHashes: []
                } satisfies RtcBaselineRuntimeObservationDto
            });
            expect(restored.ok && restored.value.observation.resolvedConfiguration).toEqual(result.value.observation.resolvedConfiguration);
            expect(restored.ok && restored.value.observation.configurationInputs).toEqual(result.value.observation.configurationInputs);
            expect(restored.ok && restored.value.observation.allowlistedEnvironment).toEqual(result.value.observation.allowlistedEnvironment);
        }
    );

    it.each(['', ' ', ' false ', 'FALSE', '0', '1', 'on', 'yes'])('rejects malformed ALM input %s', (value) => {
        const result = createRtcBaselineRuntimeObservationInput(request, { ...governedEnvironment, RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: value });
        expect(result).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: 'invalid-environment-value' })] });
    });

    it('distinguishes On and Off configuration identities without altering the workload', () => {
        const on = createRtcBaselineRuntimeObservationInput(request, { ...governedEnvironment, RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: 'true' });
        const off = createRtcBaselineRuntimeObservationInput(request, { ...governedEnvironment, RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: 'false' });
        if (!on.ok || !off.ok) {
            throw new Error('Selections must resolve');
        }
        expect(JSON.stringify(on.value.observation.resolvedConfiguration)).not.toBe(JSON.stringify(off.value.observation.resolvedConfiguration));
        expect(on.value.observation.resolvedConfiguration.filter((entry) => entry.field !== 'almDiagnostics')).toEqual(
            off.value.observation.resolvedConfiguration.filter((entry) => entry.field !== 'almDiagnostics')
        );
    });
});
