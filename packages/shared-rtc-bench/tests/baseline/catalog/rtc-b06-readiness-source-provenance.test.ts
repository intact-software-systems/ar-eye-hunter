import { expect, it } from 'vitest';

import { RTC_BASELINE_WORKLOAD_CATALOG } from '../../../baseline/catalog/rtc-baseline-workload-catalog.ts';

it('binds the exercised readiness wait, comparison, and settlement owners once in every B06 manifest', () => {
    const b06 = RTC_BASELINE_WORKLOAD_CATALOG.find((workload) => workload.workloadId === 'RTC-B06');
    expect(b06?.cases).toHaveLength(6);
    for (const entry of b06?.cases ?? []) {
        for (
            const owner of [
                'packages/shared/resilience/try-with-policy.ts',
                'packages/shared/resilience/timers.ts',
                'packages/shared/resilience/settle-all.ts',
                'packages/shared/resilience/to-error.ts',
                'packages/shared/repository/state-utils.ts'
            ]
        ) {
            expect(entry.sourcePaths.filter((path) => path === owner), `${entry.inputKey}: ${owner}`).toEqual([owner]);
        }
    }
});
