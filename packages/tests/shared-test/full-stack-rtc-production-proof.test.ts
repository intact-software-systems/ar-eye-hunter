import {
    describe,
    expect,
    it
} from 'vitest';

import {
    decodeFullStackRtcProductionProof,
    decodeProductionSeal
} from '../../shared-test/black-box-runner/fixtures/rtc-production/full-stack-rtc-production-proof.ts';

const baselineId = '20261010T100000Z-aaaaaaaaaaaa-e3-memory-gh123-a1';
const buildRoot = `/repository/tmp/perf/rtc-b06-private-build/${baselineId}/default/retained-1`;
const binding = {
    baselineId,
    attempt: {
        workloadId: 'RTC-B06',
        caseId: 'default',
        inputKey: 'e3-memory-default',
        intendedPhase: 'retained' as const,
        outerOrdinal: 1,
        environmentId: 'E3-memory',
        rawResultRelativePath: 'artifacts/staging/rtc-b06-default-e3-memory-default-retained-001.json'
    },
    git: { headCommit: 'a'.repeat(40), headTree: 'b'.repeat(40), ref: 'codex/fixture', clean: true },
    inputFiles: [{ path: 'source.ts', kind: 'source' as const, sha256: 'c'.repeat(64) }]
};
const files = [
    { path: '.vite/manifest.json', sizeBytes: 90, sha256: 'd'.repeat(64) },
    { path: 'assets/entry.js', sizeBytes: 20, sha256: 'e'.repeat(64) },
    { path: 'index.html', sizeBytes: 100, sha256: 'f'.repeat(64) }
];
const literalProof = {
    build: {
        seal: {
            version: 1,
            appServingMode: 'production',
            viteMode: 'production',
            nodeEnvironment: 'production',
            buildTarget: 'es2023',
            ...binding,
            buildRoot,
            apiOrigin: 'http://localhost:18080',
            spaOrigin: 'http://localhost:5177',
            files,
            entryFiles: ['assets/entry.js'],
            buildArguments: [
                '--workspace',
                'rallar-black-box',
                'run',
                'build',
                '--',
                '--outDir',
                `${buildRoot}/output`,
                '--emptyOutDir',
                '--mode',
                'production',
                '--target',
                'es2023'
            ]
        },
        servedFiles: files.slice(1)
    },
    entries: ['A', 'B', 'C'].flatMap((prefix) => files.slice(1).map((file) => ({ prefix, ...file })))
};

describe('canonical production serving proof', () => {
    it('accepts a literal sealed production build with exact served bytes and each original A/B/C entry', () => {
        expect(decodeFullStackRtcProductionProof(literalProof, binding).right).toEqual(literalProof);
        expect(decodeProductionSeal(literalProof.build.seal)).toEqual(literalProof.build.seal);
    });
    it.each(['serving', 'browser', 'attempt', 'input', 'query', 'mode', 'command', 'missing'] as const)(
        'denies %s proof without manufacturing a replacement identity',
        (failure) => {
            const proof = structuredClone(literalProof);
            switch (failure) {
                case 'serving':
                    proof.build.servedFiles[0]!.sha256 = '0'.repeat(64);
                    break;
                case 'browser':
                    proof.entries.pop();
                    break;
                case 'attempt':
                    proof.build.seal.attempt.outerOrdinal = 2;
                    break;
                case 'input':
                    proof.build.seal.inputFiles[0]!.sha256 = '0'.repeat(64);
                    break;
                case 'query':
                    Object.assign(proof.entries[0]!, { url: 'http://localhost/?accessToken=private' });
                    break;
                case 'mode':
                    Object.assign(proof.build.seal, { viteMode: 'development' });
                    break;
                case 'command':
                    proof.build.seal.buildArguments.push('--host');
                    break;
                case 'missing':
                    proof.build.servedFiles = [];
                    break;
            }
            expect(decodeFullStackRtcProductionProof(proof, binding).left?.length).toBeGreaterThan(0);
            expect(binding.attempt.outerOrdinal).toBe(1);
        }
    );
    it('rejects a non-string browser prefix even when its string spelling is an admitted prefix', () => {
        const proof = structuredClone(literalProof);
        const malformed = { ...proof, entries: [...proof.entries, { ...proof.entries[0]!, prefix: ['A'] }] };
        const decoded = decodeFullStackRtcProductionProof(malformed, binding);
        expect(decoded.right).toBeUndefined();
        expect(decoded.left).toContain('browser-bytes');
    });

    it('rejects unsafe and duplicate output paths and unknown proof fields', () => {
        const proof = structuredClone(literalProof);
        proof.build.seal.files.push({ path: '../private', sizeBytes: 0, sha256: 'a'.repeat(64) });
        expect(decodeFullStackRtcProductionProof(proof, binding).left).toContain('file-inventory');
        expect(decodeFullStackRtcProductionProof({ ...literalProof, credentials: 'private' }, binding).left).toContain('missing-proof');
        expect(decodeFullStackRtcProductionProof(null, binding).left).toContain('missing-seal');
    });
});
