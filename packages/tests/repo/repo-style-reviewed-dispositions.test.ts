import { spawnSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

import { scanProductionSources } from '../../../scripts/repo-style-check/repository-scan.mjs';
import { isReviewedDisposition, reviewedDispositions } from '../../../scripts/repo-style-check/reviewed-dispositions.mjs';

const repoRoot = process.cwd();
const checkerPath = path.join(repoRoot, 'scripts/check-changed-repo-style.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
    for (const fixtureRoot of fixtureRoots.splice(0)) {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

describe('reviewed repository style dispositions', () => {
    it('keeps an unchecked Relic browser cast blocking', () => {
        const findings = scanProductionSources({
            repoRoot,
            sources: [{
                file: path.join(repoRoot, 'tests/playwright/relic-hunters/web.spec.ts'),
                raw: 'void (window as unknown as { readonly __rallarWsOutbox: readonly string[]; }).__rallarWsOutbox;\n'
            }],
            options: { layoutOnly: false }
        }).findings.filter(({ ruleId }) => ruleId === 'boundary.unknown');

        expect(findings).not.toEqual([]);
        for (const finding of findings) {
            expect(finding.symbol).toBeUndefined();
            expect(isReviewedDisposition(repoRoot, finding)).toBe(false);
        }
    });

    it('preserves a genuine Relic command-kind predicate review', () => {
        const findings = scanProductionSources({
            repoRoot,
            sources: [{
                file: path.join(repoRoot, 'tests/playwright/relic-hunters/web.spec.ts'),
                raw: [
                    'function isCommandKind(body: unknown, kind: string): boolean {',
                    '    return typeof body === \'object\' &&',
                    '        body !== null &&',
                    '        \'kind\' in body &&',
                    '        (body as { kind?: unknown; }).kind === kind;',
                    '}',
                    ''
                ].join('\n')
            }],
            options: { layoutOnly: false }
        }).findings.filter(({ ruleId }) => ruleId === 'boundary.unknown');

        expect(findings).not.toEqual([]);
        for (const finding of findings) {
            expect(finding.symbol).toBe('isCommandKind');
            expect(isReviewedDisposition(repoRoot, finding)).toBe(true);
        }
    });

    it.each([[12, true], [13, true], [14, false]] as const)(
        'keeps the public barrel disposition bounded at %s exports',
        (count, reviewed) => {
            const findings = scanProductionSources({
                repoRoot,
                sources: [{ file: path.join(repoRoot, 'packages/shared-web/browser/rallar.ts'), raw: publicBarrelSource(count) }],
                options: { cognitiveMetrics: true }
            }).findings.filter(({ ruleId }) => ruleId === 'file.responsibility-count');
            expect(findings).toHaveLength(1);
            expect(findings[0].symbol).toBeUndefined();
            expect(findings[0].message).toContain(`File exports ${count} runtime values`);
            expect(isReviewedDisposition(repoRoot, findings[0])).toBe(reviewed);
        }
    );

    it('keeps wrong public barrel owners, rules and magnitudes blocking', () => {
        const finding = {
            file: path.join(repoRoot, 'packages/shared-web/browser/rallar.ts'),
            ruleId: 'file.responsibility-count',
            symbol: undefined,
            message: 'File exports 13 runtime values'
        };
        expect(isReviewedDisposition(repoRoot, { ...finding, file: `${finding.file}.other.ts` })).toBe(false);
        expect(isReviewedDisposition(repoRoot, { ...finding, symbol: 'unreviewedPublicOwner' })).toBe(false);
        expect(isReviewedDisposition(repoRoot, { ...finding, ruleId: 'file.length' })).toBe(false);
        for (const magnitude of [0, -1, 13.5, 14, Number.MAX_SAFE_INTEGER + 1]) {
            expect(isReviewedDisposition(repoRoot, { ...finding, message: `File exports ${magnitude} runtime values` })).toBe(false);
        }
        expect(isReviewedDisposition(repoRoot, { ...finding, message: 'unparseable magnitude' })).toBe(false);
    });

    it.each([[12, 0], [13, 0], [14, 1]] as const)(
        'keeps the public barrel CLI decision bounded at %s exports',
        (count, exit) => {
            const fixture = createReviewedFixture();
            writeFixture(fixture, 'packages/shared-web/browser/rallar.ts', publicBarrelSource(count));
            const result = runChangedChecker(fixture);
            expect(result.status, result.stdout).toBe(exit);
            expect(result.stdout).toContain(exit === 0 ? 'PASS: no new repository style findings' : 'file.responsibility-count');
        }
    );

    it('keeps reviewed policy entries immutable', () => {
        expect(Object.isFrozen(reviewedDispositions)).toBe(true);
        for (const disposition of reviewedDispositions) {
            expect(Object.isFrozen(disposition)).toBe(true);
        }
    });

    it('passes only the reviewed RTC baseline findings', () => {
        const fixture = createReviewedFixture();
        writeReviewedSources(fixture);

        const result = runChangedChecker(fixture);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain('PASS: no new repository style findings');
    });

    it('emits checker-owned symbols for every reviewed RTC baseline key', () => {
        const findings = scanProductionSources({
            repoRoot,
            sources: reviewedSources(repoRoot),
            options: {
                layoutOnly: false,
                layoutDetails: true,
                constructionDetails: false,
                outputContracts: true,
                objectInterfaces: true
            }
        }).findings;

        const findingKeys = findings.map(({ file, ruleId, symbol }) => ({
            path: path.relative(repoRoot, file),
            ruleId,
            symbol
        }));
        const boundaryKeys = findingKeys.filter(({ ruleId }) => ruleId === 'boundary.unknown');

        expect(boundaryKeys).toHaveLength(6);
        expect(new Set(boundaryKeys.map(({ symbol }) => symbol))).toEqual(
            new Set(['normalizeRtcBaselineJson'])
        );
        expect(findingKeys.filter(({ ruleId }) => ruleId !== 'boundary.unknown')).toEqual([
            {
                path: 'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts',
                ruleId: 'layout.primary-export-name',
                symbol: 'parseRtcBaselineCommand'
            },
            {
                path: 'packages/shared-rtc-bench/baseline/runtime/rtc-baseline-repeat-initializer.ts',
                ruleId: 'layout.primary-export-name',
                symbol: 'createRtcBaselineRepeatInitializer'
            }
        ]);
        expect(findings.find(({ message }) => message.startsWith('... and '))).toMatchObject({
            affectedCount: 3,
            symbol: 'normalizeRtcBaselineJson'
        });
    });

    it('keeps a growing unknown overflow blocking', () => {
        const file = 'apps/example/decode-boundary.ts';
        const fixture = createGitFixture({ [file]: unknownSource('decodeBoundary', 7) });
        commitAll(fixture, 'base');
        writeFixture(fixture, file, unknownSource('decodeBoundary', 8));

        const result = runChangedChecker(fixture);

        expect(result.status, result.stdout).toBe(1);
        expect(result.stdout).toContain('boundary.unknown');
    });

    it.each([
        {
            label: 'path',
            file: 'packages/shared-rtc-bench/other-baseline/rtc-baseline-decoding.ts',
            source: unknownSource('normalizeRtcBaselineJson', 7),
            ruleId: 'boundary.unknown'
        },
        {
            label: 'rule',
            file: 'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
            source: 'export function normalizeRtcBaselineJson(value: string): string { return value; }\n',
            ruleId: 'layout.primary-export-name'
        },
        {
            label: 'symbol',
            file: 'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
            source: unknownSource('normalizeOtherRtcBaselineJson', 7),
            ruleId: 'boundary.unknown'
        }
    ])('fails closed for a wrong $label', ({ file, source, ruleId }) => {
        const fixture = createGitFixture({ 'README.md': 'fixture\n' });
        commitAll(fixture, 'base');
        writeFixture(fixture, file, source);

        const result = runChangedChecker(fixture);

        expect(result.status, result.stdout).toBe(1);
        expect(result.stdout).toContain(ruleId);
    });

    it('keeps an undispositioned finding blocking beside reviewed findings', () => {
        const fixture = createReviewedFixture();
        writeReviewedSources(fixture);
        appendFixture(
            fixture,
            'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts',
            '\nfunction undispositionedFinding(a: string, b: string, c: string, d: string) {\n  return a + b + c + d;\n}\n'
        );

        const result = runChangedChecker(fixture);

        expect(result.status, result.stdout).toBe(1);
        expect(result.stdout).toContain('FAIL: 1 new or worsened repository style finding');
        expect(result.stdout).toContain('function.input-contract');
    });

    it('keeps an unknown owned by another function blocking after reviewed overflow', () => {
        const fixture = createReviewedFixture();
        writeReviewedSources(fixture);
        appendFixture(
            fixture,
            'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
            '\nexport function decodeOther(value: unknown): string { return String(value); }\n'
        );

        const result = runChangedChecker(fixture);

        expect(result.status, result.stdout).toBe(1);
        expect(result.stdout).toContain('FAIL: 1 new or worsened repository style finding');
        expect(result.stdout).toContain('boundary.unknown');
    });

    it.each([
        { relativeFile: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-crdt-controller.ts', maximumMagnitude: 117 },
        { relativeFile: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts', maximumMagnitude: 89 },
        { relativeFile: 'packages/shared/services/web-rtc-connection-service.ts', maximumMagnitude: 142 }
    ])('keeps the reviewed cognitive magnitude bounded for $relativeFile', ({ relativeFile, maximumMagnitude }) => {
        const finding = {
            file: path.join(repoRoot, relativeFile),
            ruleId: 'file.cognitive-load',
            symbol: undefined,
            message: `File cognitive load ${maximumMagnitude} reaches the review tier.`
        };
        expect(isReviewedDisposition(repoRoot, finding)).toBe(true);
        expect(isReviewedDisposition(repoRoot, {
            ...finding,
            message: `File cognitive load ${maximumMagnitude - 1} reaches the review tier.`
        })).toBe(true);
        expect(isReviewedDisposition(repoRoot, {
            ...finding,
            message: `File cognitive load ${maximumMagnitude + 1} reaches the review tier.`
        })).toBe(false);
        expect(isReviewedDisposition(repoRoot, {
            ...finding,
            message: 'File cognitive load 330 reaches the refactor-or-register tier.'
        })).toBe(false);
        expect(isReviewedDisposition(repoRoot, { ...finding, file: `${finding.file}.other.ts` })).toBe(false);
        expect(isReviewedDisposition(repoRoot, { ...finding, ruleId: 'file.length' })).toBe(false);
        expect(isReviewedDisposition(repoRoot, { ...finding, symbol: 'otherOwner' })).toBe(false);
    });

    it('bounds directory review and distinguishes checker-owned prefixes at the same path', () => {
        const directory = 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime';
        const sources = [
            ...Array.from({ length: 12 }, (_, index) => `black-owner-${index}.ts`),
            ...Array.from({ length: 9 }, (_, index) => `other-owner-${index}.ts`)
        ].map((file) => ({ file: path.join(repoRoot, directory, file), raw: '' }));
        const findings = scanProductionSources({ repoRoot, sources, options: { layoutOnly: true } }).findings;
        const density = findings.find(({ ruleId }) => ruleId === 'layout.directory-density');
        const black = findings.find(({ ruleId, symbol }) => ruleId === 'layout.feature-prefix-cluster' && symbol === 'prefix:black');
        const other = findings.find(({ ruleId, symbol }) => ruleId === 'layout.feature-prefix-cluster' && symbol === 'prefix:other');
        expect(density).toBeDefined();
        expect(black).toBeDefined();
        expect(other).toBeDefined();
        if (density === undefined || black === undefined || other === undefined) {
            throw new Error('Expected density and both independently owned prefix findings.');
        }
        expect(isReviewedDisposition(repoRoot, density)).toBe(true);
        expect(isReviewedDisposition(repoRoot, black)).toBe(true);
        expect(isReviewedDisposition(repoRoot, other)).toBe(false);
        expect(isReviewedDisposition(repoRoot, { ...black, symbol: undefined })).toBe(false);
        // Display wording cannot transfer the exact prefix ownership.
        expect(isReviewedDisposition(repoRoot, {
            ...other,
            message: black.message
        })).toBe(false);
        expect(isReviewedDisposition(repoRoot, {
            ...black,
            message: black.message.replace('prefix \'black\'', 'A reviewed feature cluster')
        })).toBe(true);
        const grown = scanProductionSources({
            repoRoot,
            sources: [...sources, { file: path.join(repoRoot, directory, 'black-owner-added.ts'), raw: '' }],
            options: { layoutOnly: true }
        }).findings;
        expect(
            grown.filter(({ ruleId }) => ruleId === 'layout.directory-density' || ruleId === 'layout.feature-prefix-cluster')
                .every((finding) => !isReviewedDisposition(repoRoot, finding))
        ).toBe(true);
    });

    it.each([
        {
            file: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
            symbols: [
                'toRtcNativeObservationProjection',
                'toNativeBody',
                'toNativeControlBody',
                'toRtcNativeIdentity',
                'toNativeSnapshot',
                'toNativeState',
                'toNativeError',
                'toNativeErrorFacts',
                'toErrorReadout',
                'toErrorCoverage',
                'toCaptureStatus',
                'toCandidate',
                'toService',
                'toServiceStage',
                'toCompactChannel',
                'toPeerSetup',
                'toTimeoutReadout',
                'toReadout',
                'toJsonObject',
                'hasOnlyKeys',
                'isOneOf',
                'isIdentityText',
                'isNonnegative',
                'isInteger'
            ]
        },
        { file: 'packages/shared/webrtc/flush-rtc-ice-candidate-queue.ts', symbols: [undefined, 'readCandidateError'] },
        { file: 'packages/shared/webrtc/qrtc-peer-connection.ts', symbols: [undefined] },
        {
            file: 'packages/shared/webrtc/rtc-native-observation-values.ts',
            symbols: [undefined, 'readRtcInteger', 'readRtcNativeErrorFacts', 'readRtcCandidateFragments', 'readRtcDataIceFragmentComparison']
        },
        { file: 'packages/tests/shared/webrtc/rtc-native-candidate-observation.test.ts', symbols: [undefined] }
    ])('recognizes only the reviewed finite native boundary keys in $file', ({ file: relativeFile, symbols }) => {
        const file = path.join(repoRoot, relativeFile);
        const raw = symbols.map((symbol) =>
            symbol === undefined
                ? 'export interface OpaqueData { readonly value: unknown; }'
                : unknownSource(symbol, 0)
        ).join('\n');
        const findings = scanProductionSources({
            repoRoot,
            sources: [{ file, raw }],
            options: { layoutOnly: false }
        }).findings.filter(({ ruleId }) => ruleId === 'boundary.unknown');
        expect(new Set(findings.map(({ symbol }) => symbol))).toEqual(new Set(symbols));
        expect(findings.filter((finding) => !isReviewedDisposition(repoRoot, finding))).toEqual([]);
        for (const finding of findings) {
            expect(isReviewedDisposition(repoRoot, { ...finding, file: `${file}.other.ts` })).toBe(false);
            expect(isReviewedDisposition(repoRoot, { ...finding, ruleId: 'function.input-contract' })).toBe(false);
            expect(isReviewedDisposition(repoRoot, { ...finding, symbol: 'unreviewedNativeDomain' })).toBe(false);
        }
        const neighbors = scanProductionSources({
            repoRoot,
            sources: [{ file, raw: `${raw}\nexport function unreviewedNativeDomain(value: unknown): string { return String(value); }\n` }],
            options: { layoutOnly: false }
        }).findings.filter(({ ruleId, symbol }) => ruleId === 'boundary.unknown' && symbol === 'unreviewedNativeDomain');
        expect(neighbors).toHaveLength(1);
        expect(isReviewedDisposition(repoRoot, { ...neighbors[0], message: findings[0].message })).toBe(false);
    });

    it.each([
        {
            file: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
            ruleId: 'file.cognitive-load',
            symbol: undefined,
            cap: 150,
            prefix: 'File cognitive load ',
            suffix: ''
        },
        {
            file: 'packages/shared/services/web-rtc-connection-service.ts',
            ruleId: 'file.cognitive-load',
            symbol: undefined,
            cap: 142,
            prefix: 'File cognitive load ',
            suffix: ''
        },
        {
            file: 'packages/shared/webrtc/qrtc-data-channel.ts',
            ruleId: 'file.cognitive-load',
            symbol: undefined,
            cap: 177,
            prefix: 'File cognitive load ',
            suffix: ''
        },
        {
            file: 'packages/shared/webrtc/qrtc-peer-connection.ts',
            ruleId: 'file.cognitive-load',
            symbol: undefined,
            cap: 267,
            prefix: 'File cognitive load ',
            suffix: ''
        },
        {
            file: 'packages/shared/webrtc/rtc-native-observation-values.ts',
            ruleId: 'file.cognitive-load',
            symbol: undefined,
            cap: 78,
            prefix: 'File cognitive load ',
            suffix: ''
        },
        {
            file: 'packages/shared/webrtc/rtc-native-observation-values.ts',
            ruleId: 'file.responsibility-count',
            symbol: undefined,
            cap: 13,
            prefix: 'File exports ',
            suffix: ' runtime values'
        },
        { file: 'packages/shared/webrtc/qrtc-peer-connection.ts', ruleId: 'file.length', symbol: undefined, cap: 1620, prefix: 'File length ', suffix: '' },
        {
            file: 'packages/shared/services/web-rtc-connection-service.ts',
            ruleId: 'file.length',
            symbol: undefined,
            cap: 1360,
            prefix: 'File length ',
            suffix: ''
        },
        {
            file: 'packages/shared/services',
            ruleId: 'layout.directory-density',
            symbol: 'services',
            cap: 21,
            prefix: 'directory has ',
            suffix: ' direct production TypeScript files'
        },
        {
            file: 'packages/shared/services',
            ruleId: 'layout.feature-prefix-cluster',
            symbol: 'prefix:web',
            cap: 5,
            prefix: 'prefix \'web\' appears in ',
            suffix: ' direct files'
        },
        {
            file: 'packages/shared/services',
            ruleId: 'layout.feature-prefix-cluster',
            symbol: 'prefix:webrtc',
            cap: 5,
            prefix: 'prefix \'webrtc\' appears in ',
            suffix: ' direct files'
        }
    ])('bounds native $ruleId at $cap for $file / $symbol', ({ file, ruleId, symbol, cap, prefix, suffix }) => {
        const finding = { file: path.join(repoRoot, file), ruleId, symbol, message: `${prefix}${cap}${suffix}` };
        for (const magnitude of [cap - 1, cap]) {
            expect(isReviewedDisposition(repoRoot, { ...finding, message: `${prefix}${magnitude}${suffix}` })).toBe(true);
        }
        for (const magnitude of [cap + 1, 0, Number.MAX_SAFE_INTEGER + 1]) {
            expect(isReviewedDisposition(repoRoot, { ...finding, message: `${prefix}${magnitude}${suffix}` })).toBe(false);
        }
        expect(isReviewedDisposition(repoRoot, { ...finding, message: 'unparseable magnitude' })).toBe(false);
        expect(isReviewedDisposition(repoRoot, { ...finding, file: `${finding.file}.other` })).toBe(false);
        expect(isReviewedDisposition(repoRoot, { ...finding, ruleId: 'function.input-contract' })).toBe(false);
        expect(isReviewedDisposition(repoRoot, { ...finding, symbol: 'unreviewedNativeDomain' })).toBe(false);
        if (ruleId === 'file.cognitive-load') {
            expect(isReviewedDisposition(repoRoot, { ...finding, message: 'File cognitive load 330' })).toBe(false);
        }
    });

    it('retains native warnings while the changed CLI recognizes the reviewed finite owner', () => {
        const relativeFile = 'packages/shared/webrtc/rtc-native-observation-values.ts';
        const raw = unknownSource('readRtcNativeErrorFacts', 7);
        const findings = scanProductionSources({
            repoRoot,
            sources: [{ file: path.join(repoRoot, relativeFile), raw }],
            options: { layoutOnly: false }
        }).findings;
        expect(findings.filter(({ ruleId }) => ruleId === 'boundary.unknown')).toHaveLength(6);
        const fixture = createReviewedFixture();
        writeFixture(fixture, relativeFile, raw);
        const reviewed = runChangedChecker(fixture);
        expect(reviewed.status, reviewed.stdout).toBe(0);
        appendFixture(fixture, relativeFile, '\nfunction unreviewedNativeDomain(a: string, b: string, c: string, d: string) { return a + b + c + d; }\n');
        const unreviewed = runChangedChecker(fixture);
        expect(unreviewed.status, unreviewed.stdout).toBe(1);
        expect(unreviewed.stdout).toContain('FAIL: 1 new or worsened repository style finding');
        expect(unreviewed.stdout).toContain('function.input-contract');
    });

    it.each([
        { cap: 1620, relativeFile: 'packages/shared/webrtc/qrtc-peer-connection.ts' },
        { cap: 1360, relativeFile: 'packages/shared/services/web-rtc-connection-service.ts' }
    ])('keeps approved length $cap bounded in the CLI for $relativeFile', ({ cap, relativeFile }) => {
        const fixture = createReviewedFixture();
        writeFixture(fixture, relativeFile, '\n'.repeat(cap - 1));
        const reviewed = runChangedChecker(fixture);
        expect(reviewed.status, reviewed.stdout).toBe(0);
        // Both comparisons use a finding-free base, so base growth tolerance cannot mask cap+1.
        appendFixture(fixture, relativeFile, '\n');
        const overCap = runChangedChecker(fixture);
        expect(overCap.status, overCap.stdout).toBe(1);
        expect(overCap.stdout).toContain(`File length ${cap + 1}`);
    });

    it('limits the service directory review to its two exact prefixes', () => {
        const directory = 'packages/shared/services';
        const sources = [
            ...Array.from({ length: 5 }, (_, index) => `web-owner-${index}.ts`),
            ...Array.from({ length: 5 }, (_, index) => `webrtc-owner-${index}.ts`),
            ...Array.from({ length: 5 }, (_, index) => `other-owner-${index}.ts`),
            'alpha.ts',
            'beta.ts',
            'gamma.ts',
            'delta.ts',
            'epsilon.ts',
            'zeta.ts'
        ].map((file) => ({ file: path.join(repoRoot, directory, file), raw: '' }));
        const findings = scanProductionSources({ repoRoot, sources, options: { layoutOnly: true } }).findings;
        const reviewed = findings.filter(({ symbol }) => symbol === 'services' || symbol === 'prefix:web' || symbol === 'prefix:webrtc');
        expect(reviewed).toHaveLength(3);
        expect(reviewed.every((finding) => isReviewedDisposition(repoRoot, finding))).toBe(true);
        const other = findings.filter(({ symbol }) => symbol === 'prefix:other');
        expect(other).toHaveLength(1);
        expect(isReviewedDisposition(repoRoot, { ...other[0], message: reviewed[0].message })).toBe(false);
        const fixture = createReviewedFixture();
        for (const source of sources) {
            writeFixture(fixture, path.relative(repoRoot, source.file), source.raw);
        }
        const result = runChangedChecker(fixture);
        expect(result.status, result.stdout).toBe(1);
        expect(result.stdout).toContain('FAIL: 1 new or worsened repository style finding');
        expect(result.stdout).toContain('prefix \'other\'');
    });

    it.each([
        { file: 'packages/shared-web/browser/rallar-operation-options.ts', symbols: ['toRallarRtcCaptureContext'] },
        { file: 'packages/tests/shared-test/rallar-browser-runtime/recipe-rtc-capture-application.test.ts', symbols: [undefined] },
        { file: 'packages/tests/shared-web/connection/browser-rtc-capture-acquisition.test.ts', symbols: [undefined] },
        {
            file: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
            symbols: ['dataChannelLanes', 'decodeBlackBoxRallarConfigFields', 'decodeBlackBoxRallarConnectionConfig']
        },
        {
            file: 'packages/shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts',
            symbols: ['validateRallarBlackBoxTestCommand']
        },
        { file: 'packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts', symbols: [undefined] }
    ])('recognizes only the reviewed recipe capture boundary keys in $file', ({ file: relativeFile, symbols }) => {
        const file = path.join(repoRoot, relativeFile);
        const raw = symbols.map((symbol) =>
            symbol === undefined
                ? 'export interface OpaqueData { readonly value: unknown; }'
                : unknownSource(symbol, 0)
        ).join('\n');
        const findings = scanProductionSources({ repoRoot, sources: [{ file, raw }], options: { layoutOnly: false } }).findings
            .filter(({ ruleId, symbol }) => ruleId === 'boundary.unknown' && symbols.some((reviewed) => reviewed === symbol));
        // Raw checker output remains visible; undefined means owner-level, not a named-method waiver.
        expect(findings).toHaveLength(symbols.length);
        expect(new Set(findings.map(({ symbol }) => symbol))).toEqual(new Set(symbols));
        expect(findings.filter((finding) => !isReviewedDisposition(repoRoot, finding))).toEqual([]);
        for (const finding of findings) {
            expect(isReviewedDisposition(repoRoot, { ...finding, file: `${file}.other.ts` })).toBe(false);
            expect(isReviewedDisposition(repoRoot, { ...finding, ruleId: 'function.input-contract' })).toBe(false);
            expect(isReviewedDisposition(repoRoot, { ...finding, symbol: 'unreviewedRecipeCaptureDomain' })).toBe(false);
        }
        const neighbor = scanProductionSources({
            repoRoot,
            sources: [{ file, raw: `${raw}\nfunction unreviewedRecipeCaptureDomain(value: unknown): string { return String(value); }\n` }],
            options: { layoutOnly: false }
        }).findings
            .filter(({ ruleId, symbol }) => ruleId === 'boundary.unknown' && symbol === 'unreviewedRecipeCaptureDomain');
        expect(neighbor).toHaveLength(1);
        expect(isReviewedDisposition(repoRoot, { ...neighbor[0], message: findings[0].message })).toBe(false);
    });

    it('bounds the cohesive auth acquisition owner at its reviewed cognitive magnitude', () => {
        const file = path.join(repoRoot, 'packages/shared-web/browser/session/session-auth-lifecycle.ts');
        const cognitive = { file, ruleId: 'file.cognitive-load', symbol: undefined, message: 'File cognitive load 50' };
        expect(isReviewedDisposition(repoRoot, cognitive)).toBe(true);
        expect(isReviewedDisposition(repoRoot, { ...cognitive, message: 'File cognitive load 49' })).toBe(true);
        for (const message of ['File cognitive load 51', 'File cognitive load 330', 'File cognitive load 0', 'unparseable magnitude']) {
            expect(isReviewedDisposition(repoRoot, { ...cognitive, message })).toBe(false);
        }
        expect(isReviewedDisposition(repoRoot, { ...cognitive, file: `${file}.other.ts` })).toBe(false);
        expect(isReviewedDisposition(repoRoot, { ...cognitive, ruleId: 'file.length' })).toBe(false);
        expect(isReviewedDisposition(repoRoot, { ...cognitive, symbol: 'connectWithIntent' })).toBe(false);
    });

    it('preserves raw recipe capture warnings while the gate accepts only its exact reviewed boundary', () => {
        const relativeFile = 'packages/shared-web/browser/rallar-operation-options.ts';
        const raw = unknownSource('toRallarRtcCaptureContext', 0);
        const findings = scanProductionSources({
            repoRoot,
            sources: [{ file: path.join(repoRoot, relativeFile), raw }],
            options: { layoutOnly: false }
        }).findings;
        expect(findings.filter(({ ruleId }) => ruleId === 'boundary.unknown')).toHaveLength(1);
        const fixture = createReviewedFixture();
        writeFixture(fixture, relativeFile, raw);
        const accepted = runChangedChecker(fixture);
        expect(accepted.status, accepted.stdout).toBe(0);
        appendFixture(
            fixture,
            relativeFile,
            '\nfunction unreviewedRecipeCaptureDomain(a: string, b: string, c: string, d: string) { return a + b + c + d; }\n'
        );
        const rejected = runChangedChecker(fixture);
        expect(rejected.status, rejected.stdout).toBe(1);
        expect(rejected.stdout).toContain('FAIL: 1 new or worsened repository style finding');
        expect(rejected.stdout).toContain('function.input-contract');
    });

    it('keeps function-owned unknown findings blocking beside a reviewed module owner', () => {
        const relativeFile = 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/director-controller.ts';
        const findings = scanProductionSources({
            repoRoot,
            sources: [{
                file: path.join(repoRoot, relativeFile),
                raw: 'export interface OpaqueData { value: unknown; }\n' +
                    'export function unreviewedDomain(value: unknown): string { return String(value); }\n'
            }],
            options: { layoutOnly: false }
        }).findings.filter(({ ruleId }) => ruleId === 'boundary.unknown');
        expect(findings.map((finding) => isReviewedDisposition(repoRoot, finding))).toEqual([true, false]);
    });
});

/** Synthetic exports exercise policy without coupling a test to SDK implementation source. */
function publicBarrelSource(count: number): string {
    return Array.from({ length: count }, (_, index) => `export const publicValue${index} = ${index};`).join('\n');
}

function createReviewedFixture(): string {
    const fixture = createGitFixture({ 'README.md': 'fixture\n' });
    commitAll(fixture, 'base');
    return fixture;
}

function reviewedSources(root: string) {
    return [
        {
            file: path.join(
                root,
                'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts'
            ),
            raw: unknownSource('normalizeRtcBaselineJson', 7)
        },
        {
            file: path.join(
                root,
                'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts'
            ),
            raw: primaryExportSource('parseRtcBaselineCommand')
        },
        {
            file: path.join(
                root,
                'packages/shared-rtc-bench/baseline/runtime/rtc-baseline-repeat-initializer.ts'
            ),
            raw: primaryExportSource('createRtcBaselineRepeatInitializer')
        }
    ];
}

function writeReviewedSources(fixture: string): void {
    for (const source of reviewedSources(fixture)) {
        writeFixture(fixture, path.relative(fixture, source.file), source.raw);
    }
}

function primaryExportSource(symbol: string): string {
    return `export function ${symbol}(value: string): string { return value; }\n`;
}

function unknownSource(symbol: string, localCount: number): string {
    return [
        'export interface RtcBaselineJson { readonly value: string; }',
        `export function ${symbol}(value: unknown): string {`,
        ...Array.from({ length: localCount }, (_, index) => `  const value${index}: unknown = value;`),
        '  return String(value);',
        '}',
        ''
    ].join('\n');
}

function createGitFixture(files: Readonly<Record<string, string>>): string {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'reviewed-style-fixture-'));
    fixtureRoots.push(fixtureRoot);
    runGit(fixtureRoot, ['init', '--initial-branch=main']);
    runGit(fixtureRoot, ['config', 'user.name', 'Repo Style Test']);
    runGit(fixtureRoot, ['config', 'user.email', 'repo-style@example.invalid']);
    for (const [relativePath, source] of Object.entries(files)) {
        writeFixture(fixtureRoot, relativePath, source);
    }
    return fixtureRoot;
}

function writeFixture(fixtureRoot: string, relativePath: string, source: string): void {
    const filePath = path.join(fixtureRoot, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, source);
}

function appendFixture(fixtureRoot: string, relativePath: string, source: string): void {
    const filePath = path.join(fixtureRoot, relativePath);
    writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}${source}`);
}

function commitAll(fixtureRoot: string, message: string): void {
    runGit(fixtureRoot, ['add', '.']);
    runGit(fixtureRoot, ['commit', '-m', message]);
}

function runChangedChecker(fixtureRoot: string) {
    return spawnSync(process.execPath, [checkerPath, 'HEAD'], {
        cwd: fixtureRoot,
        encoding: 'utf8'
    });
}

function runGit(fixtureRoot: string, args: readonly string[]): void {
    const result = spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
}
