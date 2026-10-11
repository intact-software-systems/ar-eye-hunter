import { describe, expect, it } from 'vitest';

import { parseBenchmarkOptions } from '../../../../../apps/api-v1/scripts/perf/state-write/api-v1-state-write-benchmark-options.ts';

describe('state-write diagnostic opt-in', () => {
    it('disables retention unless an explicit fresh-directory destination is requested', () => {
        expect(parseBenchmarkOptions(['--out=tmp/perf/candidate.json'])).toEqual({
            backend: 'postgres',
            warmup: 1,
            runs: 3,
            concurrency: 10,
            out: 'tmp/perf/candidate.json',
            diagnostics: { kind: 'disabled' }
        });
        expect(parseBenchmarkOptions(['--diagnostics-dir=tmp/perf/timeline'])).toHaveProperty('diagnostics', {
            kind: 'enabled',
            directory: 'tmp/perf/timeline'
        });
    });

    it('rejects an empty diagnostic destination without reflecting its contents', () => {
        expect(() => parseBenchmarkOptions(['--diagnostics-dir='])).toThrow('Diagnostic directory must be nonempty');
    });
});
