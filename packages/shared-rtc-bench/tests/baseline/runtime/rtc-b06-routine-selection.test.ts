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
        { caseKey, field: 'eventHistoryMode', value: 'full', source: 'default' as const },
        { caseKey, field: 'eventHistoryMaxEvents', value: 0, source: 'default' as const },
        { caseKey, field: 'almDiagnostics', value: true, source: 'default' as const },
        ...(failure === 'missing' ? [] : [failure === 'wrong-case' ? { ...recording, caseKey: { ...caseKey, caseId: 'other' } } : recording]),
        ...(failure === 'duplicate' ? [recording] : [])
    ];
    expect(resolveRtcB06DiagnosticSelection(entries, caseKey)).toMatchObject({ ok: false });
});

it('binds full default history and recent/64 retention in initialized configuration', () => {
    const result = createRtcBaselineRuntimeObservationInput(request, workloadEnvironment);
    if (!result.ok) {
        throw new Error(JSON.stringify(result.issues));
    }
    expect(
        result.value.observation.resolvedConfiguration.filter((entry) => entry.field === 'eventHistoryMode').map((
            entry
        ) => [entry.caseKey.caseId, entry.value, entry.source])
    )
        .toEqual([['default', 'full', 'default'], ['all-scenarios', 'full', 'default'], ['retention-100', 'recent', 'default']]);
    expect(result.value.observation.resolvedConfiguration.filter((entry) => entry.field === 'eventHistoryMaxEvents').map((entry) => entry.value)).toEqual([
        0,
        0,
        64
    ]);
});

it('executes the frozen recent/64 producer selection after stripping conflicting ambient history', () => {
    const command = createRtcB06LiveProducerCommand({
        repositoryRoot: '/repository',
        baselineId: 'history',
        eventHistory: { mode: 'recent', maxEvents: 64 },
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
        'process.stdout.write(JSON.stringify([process.env.VITE_RALLAR_EVENT_HISTORY, process.env.VITE_RALLAR_EVENT_HISTORY_MAX_EVENTS]))'
    ], {
        encoding: 'utf8',
        env: { ...process.env, VITE_RALLAR_EVENT_HISTORY: 'full', VITE_RALLAR_EVENT_HISTORY_MAX_EVENTS: '999' }
    });
    expect(JSON.parse(value)).toEqual(['recent', '64']);
});

it.each(['missing-mode', 'missing-bound', 'duplicate', 'wrong-case', 'invalid-mode', 'fractional', 'full-bound'])(
    'rejects %s initialized history selection',
    async (failure) => {
        const { resolveRtcB06DiagnosticSelection } = await import('../../../baseline/observation/read-rtc-b06-diagnostic-selection.ts');
        const caseKey = { workloadId: 'RTC-B06', caseId: 'retention-100', inputKey: 'e3-memory-retention-100' } as const;
        const mode = {
            caseKey,
            field: 'eventHistoryMode',
            value: failure === 'invalid-mode' ? 'invalid' : failure === 'full-bound' ? 'full' : 'recent',
            source: 'default' as const
        };
        const bound = { caseKey, field: 'eventHistoryMaxEvents', value: failure === 'fractional' ? 64.5 : 64, source: 'default' as const };
        const entries = [
            { caseKey, field: 'almDiagnostics', value: false, source: 'environment' as const },
            { caseKey, field: 'routineBrowserDiagnostics', value: 'disabled', source: 'environment' as const },
            ...(failure === 'missing-mode' ? [] : [failure === 'wrong-case' ? { ...mode, caseKey: { ...caseKey, caseId: 'other' } } : mode]),
            ...(failure === 'missing-bound' ? [] : [bound]),
            ...(failure === 'duplicate' ? [mode] : [])
        ];
        expect(resolveRtcB06DiagnosticSelection(entries, caseKey)).toMatchObject({ ok: false, issues: [{ code: 'invalid-event-history-selection' }] });
    }
);

it('returns the exact initialized RTC capture mode with its per-case diagnostics', async () => {
    const { resolveRtcB06DiagnosticSelection } = await import('../../../baseline/observation/read-rtc-b06-diagnostic-selection.ts');
    const initialized = createRtcBaselineRuntimeObservationInput(request, { ...workloadEnvironment, RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: 'native' });
    if (!initialized.ok) {
        throw new Error(JSON.stringify(initialized.issues));
    }
    expect(
        resolveRtcB06DiagnosticSelection(initialized.value.observation.resolvedConfiguration, {
            workloadId: 'RTC-B06',
            caseId: 'retention-100',
            inputKey: 'e3-memory-retention-100'
        })
    ).toMatchObject({ ok: true, value: { rtcCaptureMode: 'native' } });
});

it.each(['missing', 'duplicate', 'invalid'])('rejects %s initialized RTC capture without guessing a launch default', async (failure) => {
    const { resolveRtcB06DiagnosticSelection } = await import('../../../baseline/observation/read-rtc-b06-diagnostic-selection.ts');
    const initialized = createRtcBaselineRuntimeObservationInput(request, workloadEnvironment);
    if (!initialized.ok) {
        throw new Error(JSON.stringify(initialized.issues));
    }
    const caseKey = { workloadId: 'RTC-B06', caseId: 'retention-100', inputKey: 'e3-memory-retention-100' } as const;
    const configuration = initialized.value.observation.resolvedConfiguration;
    const selected = configuration.find((entry) => entry.field === 'rtcCaptureMode' && entry.caseKey.caseId === 'retention-100')!;
    const changed = failure === 'missing'
        ? configuration.filter((entry) => entry !== selected)
        : failure === 'duplicate'
        ? [...configuration, selected]
        : configuration.map((entry) => entry === selected ? { ...entry, value: 'invalid' } : entry);
    expect(resolveRtcB06DiagnosticSelection(changed, caseKey)).toMatchObject({
        ok: false,
        issues: [{ code: failure === 'invalid' ? 'invalid-rtc-capture-mode' : 'missing-capture-admission' }]
    });
});
