import { join, resolve } from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';

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

    it.each(['phase-0.ndjson', 'phase-0.ndjson.partial', 'receipt.json', 'receipt.json.partial', ''])(
        'rejects canonical overlap with diagnostic %s for relative and absolute spellings',
        (name) => {
            const directory = 'tmp/perf/capture';
            const destination = join(directory, name);
            for (const out of [destination, resolve(destination)]) {
                for (const diagnostics of [directory, resolve(directory, '..', 'capture')]) {
                    expect(() => parseBenchmarkOptions([`--out=${out}`, `--diagnostics-dir=${diagnostics}`]))
                        .toThrow('Canonical output and diagnostic directory must be disjoint');
                }
            }
        }
    );

    it('rejects a canonical file that is also an ancestor of the diagnostic directory', () => {
        expect(() => parseBenchmarkOptions(['--out=tmp/perf/capture', '--diagnostics-dir=tmp/perf/capture/nested']))
            .toThrow('Canonical output and diagnostic directory must be disjoint');
    });

    it('accepts normalized sibling destinations without treating a shared name prefix as overlap', () => {
        expect(parseBenchmarkOptions(['--out=tmp/perf/capture/../capture-other/receipt.json', '--diagnostics-dir=./tmp/perf/capture']))
            .toHaveProperty('out', 'tmp/perf/capture/../capture-other/receipt.json');
    });
});
