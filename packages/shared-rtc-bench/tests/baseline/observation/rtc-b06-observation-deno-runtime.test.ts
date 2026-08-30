import { describe, expect, it } from 'vitest';

import { createRtcB06LiveProducerCommand } from '../../../baseline/observation/rtc-b06-observation-deno-runtime.ts';

const baselineId = '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3';

function attempt(caseId: 'default' | 'all-scenarios' | 'retention-100') {
    return {
        workloadId: 'RTC-B06' as const,
        caseId,
        inputKey: `e3-memory-${caseId}`,
        intendedPhase: 'retained' as const,
        outerOrdinal: 2,
        environmentId: 'E3-memory' as const,
        rawResultRelativePath: `artifacts/staging/rtc-b06-${caseId}-e3-memory-${caseId}-retained-002.json`
    };
}

const commonArguments = [
    '-u',
    'DATABASE_URL',
    '-u',
    'RALLAR_ICE_MODE',
    '-u',
    'RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS',
    '-u',
    'RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK',
    '-u',
    'RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES',
    `RALLAR_BLACK_BOX_RTC_BASELINE_ID=${baselineId}`,
    'RALLAR_BLACK_BOX_RTC_CASE_ID=default',
    'RALLAR_BLACK_BOX_RTC_INPUT_KEY=e3-memory-default',
    'RALLAR_BLACK_BOX_RTC_INTENDED_PHASE=retained',
    'RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL=2'
];

describe('RTC-B06 observation Deno runtime', () => {
    it('starts the default E3 producer with database and scenario inheritance removed', () => {
        expect(createRtcB06LiveProducerCommand({ baselineId, attempt: attempt('default') }))
            .toEqual({
                executable: 'env',
                arguments: [
                    ...commonArguments,
                    'npm',
                    'run',
                    'test:rallar:full-stack:memory:live-rtc-3'
                ]
            });
    });

    it('enables only the all-scenarios flag for that case', () => {
        const command = createRtcB06LiveProducerCommand({
            baselineId,
            attempt: attempt('all-scenarios')
        });

        expect(command.arguments).toContain('RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1');
        expect(command.arguments).not.toContain('RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1');
        expect(command.arguments).not.toContain('RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100');
        expect(command.arguments).toContain(
            'RALLAR_BLACK_BOX_RTC_INPUT_KEY=e3-memory-all-scenarios'
        );
    });

    it('enables exactly the governed 100-cycle retention configuration', () => {
        const command = createRtcB06LiveProducerCommand({
            baselineId,
            attempt: attempt('retention-100')
        });

        expect(command.arguments).not.toContain('RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1');
        expect(command.arguments).toContain('RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1');
        expect(command.arguments).toContain('RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100');
        expect(command.arguments).toContain(
            'RALLAR_BLACK_BOX_RTC_CASE_ID=retention-100'
        );
    });
});
