import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { RtcBaselineCaptureRequestDto } from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import { createRtcB06LiveProducerCommand } from '../../../baseline/observation/rtc-b06-observation-deno-runtime.ts';
import { createRtcBaselineRuntimeObservationInput } from '../../../baseline/runtime/create-rtc-baseline-runtime-observation-input.ts';

const request: RtcBaselineCaptureRequestDto = {
    schema: 'rallar.rtc-baseline.capture-request.v1',
    baselineId: 'recording',
    workloadIds: ['RTC-B06'],
    environmentId: 'E3-memory',
    retainedSampleMultiplier: 1,
    repeatLink: null,
    conditionalEnvironmentDecisions: []
};
const workloadEnvironment = {
    RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1',
    RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
    RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100'
};
it.each([undefined, 'enabled', 'disabled'])('freezes only retention recording %s independently of ALM', (mode) => {
    const result = createRtcBaselineRuntimeObservationInput(request, {
        ...workloadEnvironment,
        RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: 'false',
        ...(mode === undefined ? {} : { RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS: mode })
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
        throw new Error(JSON.stringify(result.issues));
    }
    expect(
        result.value.observation.resolvedConfiguration.filter((entry) => entry.field === 'routineBrowserDiagnostics')
            .map((entry) => [entry.caseKey.caseId, entry.value])
    ).toEqual([
        ['default', 'enabled'],
        ['all-scenarios', 'enabled'],
        ['retention-100', mode ?? 'enabled']
    ]);
    expect(
        result.value.observation.resolvedConfiguration.filter((entry) => entry.field === 'almDiagnostics')
            .map((entry) => entry.value)
    ).toEqual([true, true, false]);
});
it.each(['off', 'false', 'Disabled', '', ' disabled '])('refuses malformed recording %j at initialization', (mode) => {
    expect(createRtcBaselineRuntimeObservationInput(request, { ...workloadEnvironment, RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS: mode }))
        .toMatchObject({ ok: false });
});
it.each(['enabled', 'disabled'] as const)('launches an explicit %s child against conflicting ambient selection', (mode) => {
    const command = createRtcB06LiveProducerCommand({
        repositoryRoot: '/repository',
        baselineId: 'recording',
        routineBrowserDiagnostics: mode,
        attempt: {
            workloadId: 'RTC-B06',
            caseId: 'retention-100',
            inputKey: 'e3-memory-retention-100',
            intendedPhase: 'retained',
            outerOrdinal: 1,
            environmentId: 'E3-memory',
            rawResultRelativePath: 'artifacts/staging/attempt.json'
        }
    });
    const value = execFileSync(command.executable, [
        ...command.arguments.slice(0, command.arguments.indexOf('npm')),
        process.execPath,
        '--eval',
        'process.stdout.write(process.env.RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS)'
    ], { encoding: 'utf8', env: { ...process.env, RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS: mode === 'enabled' ? 'disabled' : 'enabled' } });
    expect(value).toBe(mode);
    expect(command.arguments.slice(command.arguments.indexOf('npm'), command.arguments.indexOf('npm') + 3))
        .toEqual(['npm', 'run', 'test:rallar:full-stack:memory:live-rtc-3']);
});

it.each(['missing', 'duplicate', 'wrong-case', 'unsupported', 'disabled-default'])('rejects %s frozen recording selection', async (failure) => {
    const { resolveRtcB06DiagnosticSelection } = await import('../../../baseline/observation/read-rtc-b06-diagnostic-selection.ts');
    const caseKey = { workloadId: 'RTC-B06', caseId: failure === 'disabled-default' ? 'default' : 'retention-100', inputKey: 'input' } as const;
    const recording = { caseKey, field: 'routineBrowserDiagnostics', value: failure === 'unsupported' ? 'off' : 'disabled', source: 'environment' as const };
    const entries = [
        { caseKey, field: 'almDiagnostics', value: true, source: 'default' as const },
        ...(failure === 'missing' ? [] : [failure === 'wrong-case' ? { ...recording, caseKey: { ...caseKey, caseId: 'other' } } : recording]),
        ...(failure === 'duplicate' ? [recording] : [])
    ];
    expect(resolveRtcB06DiagnosticSelection(entries, caseKey)).toMatchObject({ ok: false });
});
