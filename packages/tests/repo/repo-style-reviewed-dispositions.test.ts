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
import {
    isReviewedDisposition,
    readReviewedDispositionContext,
    reviewedDispositions
} from '../../../scripts/repo-style-check/reviewed-dispositions.mjs';

const repoRoot = process.cwd();
const checkerPath = path.join(repoRoot, 'scripts/check-changed-repo-style.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
    for (const fixtureRoot of fixtureRoots.splice(0)) {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

describe('reviewed repository style dispositions', () => {
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
                path: 'packages/shared-rtc-bench/baseline/runtime/rtc-baseline-deno-acceptance.ts',
                ruleId: 'layout.primary-export-name',
                symbol: 'createRtcBaselineDenoAcceptance'
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
        { relativeFile: 'packages/shared/services/web-rtc-connection-service.ts', maximumMagnitude: 105 }
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
            ...Array.from({ length: 13 }, (_, index) => `black-owner-${index}.ts`),
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

    it('matches a receipt disposition only at exact native magnitude and candidate head', () => {
        const file = path.join(repoRoot, 'packages/example/large-owner.ts');
        const finding = {
            file,
            ruleId: 'file.cognitive-load',
            symbol: undefined,
            message: 'File cognitive load 112 reaches the required-separation-review tier.'
        };
        const decision = {
            decisionId: 'd'.repeat(64),
            projection: {
                rule: 'file.cognitive-load',
                path: 'packages/example/large-owner.ts',
                symbol: null,
                magnitude: 112,
                candidateHead: 'a'.repeat(40)
            }
        };

        expect(
            isReviewedDisposition(repoRoot, finding, {
                candidateHead: 'a'.repeat(40),
                decisions: [decision]
            })
        ).toBe(true);
        expect(
            isReviewedDisposition(repoRoot, finding, {
                candidateHead: 'b'.repeat(40),
                decisions: [decision]
            })
        ).toBe(false);
        expect(
            isReviewedDisposition(
                repoRoot,
                { ...finding, message: finding.message.replace('112', '113') },
                {
                    candidateHead: 'a'.repeat(40),
                    decisions: [decision]
                }
            )
        ).toBe(false);
    });

    it('keeps trusted-main receipt verification issues visible and fail closed', () => {
        const context = readReviewedDispositionContext(repoRoot, 'a'.repeat(40), {
            readGovernanceDecisionIndex: () => ({
                decisions: [],
                duplicateDecisionIds: new Set(),
                issues: ['forged receipt was excluded']
            })
        });

        expect(context.decisions).toEqual([]);
        expect(context.issues).toEqual(['forged receipt was excluded']);
    });
});

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
                'packages/shared-rtc-bench/baseline/runtime/rtc-baseline-deno-acceptance.ts'
            ),
            raw: primaryExportSource('createRtcBaselineDenoAcceptance')
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
