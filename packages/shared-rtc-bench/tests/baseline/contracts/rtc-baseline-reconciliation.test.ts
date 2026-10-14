import {
    describe,
    expect,
    it
} from 'vitest';

import { validateRtcBaselineReconciliation } from '../../../baseline/contracts/rtc-baseline-artifact-validation.ts';

describe('RTC baseline semantic JSON reconciliation', () => {
    it('accepts reordered nested object keys without changing values', () => {
        expect(validateRtcBaselineReconciliation(
            {
                workerCommand: {
                    redactedArgv: { executable: 'deno', arguments: ['run', 'worker.ts'] },
                    projection: { ['\u00e9']: 'first', ['e\u0301']: 'second' }
                }
            },
            {
                workerCommand: {
                    projection: { ['e\u0301']: 'second', ['\u00e9']: 'first' },
                    redactedArgv: { arguments: ['run', 'worker.ts'], executable: 'deno' }
                }
            }
        )).toEqual([]);
    });

    it('accepts reversed collation-equivalent keys in the observed environment', () => {
        expect(validateRtcBaselineReconciliation(
            { allowlistedEnvironment: { ['\u00e9']: 'first', ['e\u0301']: 'second' } },
            { allowlistedEnvironment: { ['e\u0301']: 'second', ['\u00e9']: 'first' } }
        )).toEqual([]);
    });

    it.each([
        ['addition', { existing: '1', added: '2' }],
        ['removal', {}],
        ['changed value', { existing: '2' }],
        ['distinct Unicode key', { ['e\u0301']: '1' }]
    ])('rejects environment map %s', (_change, current) => {
        expect(validateRtcBaselineReconciliation(
            { allowlistedEnvironment: { existing: '1' } },
            { allowlistedEnvironment: current }
        )).toEqual([{
            path: '$.allowlistedEnvironment',
            code: 'reconciliation-mismatch',
            message: 'Runtime observation field allowlistedEnvironment changed.'
        }]);
    });

    it.each(
        [
            ['configuration value', 'resolvedConfiguration', [{ field: 'almDiagnostics', value: true, source: 'environment' }], [
                { field: 'almDiagnostics', value: false, source: 'environment' }
            ]],
            ['configuration source', 'resolvedConfiguration', [{ field: 'almDiagnostics', value: true, source: 'environment' }], [
                { field: 'almDiagnostics', value: true, source: 'default' }
            ]],
            ['source hash', 'sourceHashes', [{ path: 'worker.ts', sha256: 'a'.repeat(64) }], [{ path: 'worker.ts', sha256: 'b'.repeat(64) }]],
            ['source order', 'sourceHashes', [{ path: 'first.ts' }, { path: 'second.ts' }], [{ path: 'second.ts' }, { path: 'first.ts' }]],
            ['argv order', 'workerCommand', { redactedArgv: { executable: 'deno', arguments: ['run', 'worker.ts'] } }, {
                redactedArgv: { executable: 'deno', arguments: ['worker.ts', 'run'] }
            }]
        ] as const
    )('rejects changed %s', (_change, field, initialized, current) => {
        expect(validateRtcBaselineReconciliation({ [field]: initialized }, { [field]: current })).toEqual([{
            path: `$.${field}`,
            code: 'reconciliation-mismatch',
            message: `Runtime observation field ${field} changed.`
        }]);
    });
});
