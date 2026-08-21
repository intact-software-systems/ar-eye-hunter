import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FILES = [
    'apps/rallar-black-box-control-server/src/control-service.ts',
    'apps/rallar-black-box-control-server/src/control-artifacts.ts',
    'apps/rallar-black-box-control-server/src/main.ts',
    'apps/rallar-black-box-control-server/test/control-service.test.ts',
    'apps/rallar-black-box-control-server/test/control-artifacts.test.ts'
];

const FORBIDDEN_IMPORTS = [
    '../../rallar-black-box/src/control-protocol.ts',
    '../rallar-black-box/src/control-protocol.ts',
    '../../../apps/rallar-black-box/src/control-protocol.ts',
    '../../../apps/rallar-black-box/src/distributed-run-artifact-analysis.ts'
];

describe('black-box control protocol package boundary', () => {
    it('does not import control protocol from the SPA app into the control server', () => {
        for (const file of FILES) {
            const source = readFileSync(file, 'utf8');
            for (const forbidden of FORBIDDEN_IMPORTS) {
                expect(source, `${file} imports ${forbidden}`).not.toContain(forbidden);
            }
        }
    });

    it('keeps distributed run monitor derivation in shared-test instead of the SPA app', () => {
        const source = readFileSync('apps/rallar-black-box/src/distributed-recipes.ts', 'utf8');

        expect(source).toContain('@shared-test/rallar-bb-test/distributed-run-monitor.ts');
        expect(source).not.toContain('export function deriveDistributedRunMonitor');
        expect(source).not.toContain('export function deriveDistributedRunAnalysisReport');
        expect(source).not.toContain('export function deriveRunVerdictView');
    });
});
