import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { decodeALMObservationPageDiagnosticsFile } from '../../shared-test/rallar-bb-test/conformance/alm/alm-observation-page-diagnostics.ts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const fixtureRoot = path.join(repoRoot, 'packages/tests/shared-test/fixtures/rallar-bb-test');
const SAMPLE_FIXTURE = 'alm-observation-page-diagnostics-sample.json';

function readFixture(fixtureName: string): unknown {
    return JSON.parse(readFileSync(path.join(fixtureRoot, fixtureName), 'utf8'));
}

describe('decodeALMObservationPageDiagnosticsFile', () => {
    it('rejects a value that is not an object', () => {
        expect(decodeALMObservationPageDiagnosticsFile(42).left).toEqual([
            'page diagnostics file is not an object'
        ]);
    });

    it('reports every missing part of an unusable file at once', () => {
        expect(decodeALMObservationPageDiagnosticsFile({ records: {} }).left).toEqual([
            'page diagnostics file.droppedCount is not a finite number',
            'page diagnostics file.records is not an array'
        ]);
    });

    it('decodes a fixture with a few records and skips the one missing an agent id', () => {
        const decoded = decodeALMObservationPageDiagnosticsFile(readFixture(SAMPLE_FIXTURE));

        expect(decoded.left).toBeUndefined();
        expect(decoded.right?.droppedCount).toBe(2);
        expect(decoded.right?.records).toHaveLength(3);
        expect(decoded.right?.records.map((record) => record.kind)).toEqual([
            'console-error',
            'pageerror',
            'console-warning'
        ]);
        expect(decoded.right?.records[1]).toEqual({
            agentId: 'alm-receiver-w0-fixture',
            role: 'receiver',
            atMs: 340,
            kind: 'pageerror',
            message: 'ReferenceError: rallar is not defined',
            stack: 'ReferenceError: rallar is not defined\n at index.html:1:1'
        });
    });
});
