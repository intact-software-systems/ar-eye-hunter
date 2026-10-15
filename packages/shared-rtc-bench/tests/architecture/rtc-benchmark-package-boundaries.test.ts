import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const packageRoot = path.join(repoRoot, 'packages/shared-rtc-bench');
const benchmarkPackageName = '@ar-eye-hunter/shared-rtc-bench';
const browserSoakProducerPath = path.join(packageRoot, 'workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs');
const canonicalEitherPath = path.join(repoRoot, 'packages/shared/resilience/Either.ts');
const finiteIceFixturePolicyPath = path.join(repoRoot, 'packages/shared-test/black-box-runner/fixtures/full-stack-rtc-ice-fixture-policy.ts');
const browserRecordingContractPath = path.join(repoRoot, 'packages/shared-test/black-box-runner/fixtures/browser-diagnostics-recording.ts');
const eventHistoryOwnerPath = path.join(repoRoot, 'packages/shared-test/rallar-bb-test/runtime/event-history.ts');
const productionFixturePaths = ['full-stack-rtc-production-proof.ts', 'full-stack-rtc-build-tool-provenance.ts'].map((name) =>
    path.join(repoRoot, 'packages/shared-test/black-box-runner/fixtures/rtc-production', name)
);
const performanceScriptRoots = ['scripts/platform/perf', 'apps/api-v1/scripts/perf'] as const;
const approvedRepositoryImportPrefixes = ['@shared/', '@shared-web/', '@shared-server/'] as const;
const approvedExternalImports = new Set([
    '@playwright/test',
    '@std/path',
    'fflate',
    'graphology',
    'postgres',
    'vitest'
]);

function readFilesBelow(root: string): string[] {
    if (!fs.existsSync(root)) {
        return [];
    }
    return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory() && ['node_modules', 'dist', 'coverage'].includes(entry.name)) {
            return [];
        }
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            return readFilesBelow(entryPath);
        }
        return entry.isFile() ? [entryPath] : [];
    });
}

function readRtcPerformanceScriptSources(): string[] {
    return performanceScriptRoots
        .flatMap((root) => readFilesBelow(path.join(repoRoot, root)))
        .filter((file) => /(^|\/)(rtc|webrtc)/.test(path.relative(repoRoot, file)));
}

function parseImportSpecifiers(source: string): string[] {
    const fromOrDynamicImports = [...source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)];
    const sideEffectImports = [...source.matchAll(/\bimport\s+(['"])([^'"]+)\1/g)];
    return [...fromOrDynamicImports, ...sideEffectImports].map((match) => match[2]);
}

function isPackageLocalImport(file: string, specifier: string): boolean {
    if (!specifier.startsWith('.')) {
        return false;
    }
    const withoutQuery = specifier.split('?')[0];
    const relativeTarget = path.relative(packageRoot, path.resolve(path.dirname(file), withoutQuery));
    return (
        relativeTarget === '' || (!relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget))
    );
}

function isApprovedImport(file: string, specifier: string): boolean {
    if (file === browserSoakProducerPath && specifier.startsWith('.') && path.resolve(path.dirname(file), specifier) === canonicalEitherPath) {
        return true;
    }
    if (
        specifier.startsWith('.') &&
        [finiteIceFixturePolicyPath, browserRecordingContractPath, eventHistoryOwnerPath, ...productionFixturePaths].includes(
            path.resolve(path.dirname(file), specifier)
        )
    ) {
        return true;
    }
    if (isPackageLocalImport(file, specifier)) {
        return true;
    }
    if (
        specifier === benchmarkPackageName ||
        specifier.startsWith(`${benchmarkPackageName}/`) ||
        specifier.startsWith('node:')
    ) {
        return true;
    }
    if (approvedRepositoryImportPrefixes.some((prefix) => specifier.startsWith(prefix))) {
        return true;
    }
    return approvedExternalImports.has(specifier);
}

function readUnapprovedImports(file: string): string[] {
    return parseImportSpecifiers(fs.readFileSync(file, 'utf8'))
        .filter((specifier) => !isApprovedImport(file, specifier))
        .map((specifier) => `${path.relative(repoRoot, file)} -> ${specifier}`);
}

function isBenchmarkPackageSpecifier(specifier: string): boolean {
    return specifier === benchmarkPackageName || specifier.startsWith(`${benchmarkPackageName}/`);
}

function isForbiddenBenchmarkImport(file: string, specifier: string): boolean {
    const repositoryPath = path.relative(repoRoot, file).split(path.sep).join('/');
    if (repositoryPath.startsWith('packages/tests/') && /\.test\.[cm]?[jt]s$/.test(repositoryPath)) {
        return false;
    }
    if (isBenchmarkPackageSpecifier(specifier)) {
        return true;
    }
    if (!specifier.startsWith('.')) {
        return false;
    }
    const relativeTarget = path.relative(packageRoot, path.resolve(path.dirname(file), specifier));
    return relativeTarget === '' || (!relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget));
}

function readBenchmarkPackageUsage(file: string): boolean {
    return parseImportSpecifiers(fs.readFileSync(file, 'utf8')).some((specifier) => isForbiddenBenchmarkImport(file, specifier));
}

describe('shared RTC benchmark package boundaries', () => {
    it('loads the canonical Either owner through standalone Node producer admission', () => {
        const result = spawnSync(process.execPath, [browserSoakProducerPath, '--iterations=0'], {
            cwd: repoRoot,
            encoding: 'utf8'
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr.trim()).toBe('RTC-B05: option --iterations must be an integer from 1 through 10000');
    });

    it('limits the standalone producer relative shared dependency to canonical Either', () => {
        expect(isApprovedImport(browserSoakProducerPath, '../../../shared/resilience/Either.ts')).toBe(true);
        expect(isApprovedImport(browserSoakProducerPath, '../../../shared/api/api-json-value.ts')).toBe(false);
        expect(isApprovedImport(path.join(packageRoot, 'workloads/another-consumer.mjs'), '../../shared/resilience/Either.ts')).toBe(false);
    });

    it('enforces the exact direct-import allowlist and reverse-import package prefix', () => {
        const packageFile = path.join(packageRoot, 'tests/architecture/example.test.ts');
        expect(
            [
                './package-owner.ts',
                '@ar-eye-hunter/shared-rtc-bench/baseline/contracts',
                '@shared/contracts/example.ts',
                '@shared-web/browser/example.ts',
                '@shared-server/runtime-state/example.ts',
                'node:path',
                '@playwright/test',
                '@std/path',
                'fflate',
                'graphology',
                'postgres',
                'vitest'
            ].every((specifier) => isApprovedImport(packageFile, specifier))
        ).toBe(true);
        expect(
            [
                '../../../scripts/perf/example.ts',
                '../../../apps/api-v1/example.ts',
                '@shared-graph/example.ts',
                '@shared-test/example.ts',
                '@ar-eye-hunter/another-package'
            ].every((specifier) => !isApprovedImport(packageFile, specifier))
        ).toBe(true);
        expect(isBenchmarkPackageSpecifier('@ar-eye-hunter/shared-rtc-bench/internal')).toBe(true);
        expect(isBenchmarkPackageSpecifier('@ar-eye-hunter/shared-rtc-bench-other/internal')).toBe(false);
        expect(isBenchmarkPackageSpecifier('@ar-eye-hunter/another-package')).toBe(false);
    });

    it('admits only the dependency-free finite ICE fixture data, without opening runner imports', () => {
        const catalogFile = path.join(packageRoot, 'baseline/catalog/rtc-baseline-workload-catalog.ts');
        expect(isApprovedImport(catalogFile, '../../../shared-test/black-box-runner/fixtures/full-stack-rtc-ice-fixture-policy.ts')).toBe(true);
        expect(isApprovedImport(catalogFile, '../../../shared-test/black-box-runner/rallar-in-memory-runtime.ts')).toBe(false);
        expect(parseImportSpecifiers(fs.readFileSync(finiteIceFixturePolicyPath, 'utf8'))).toEqual([]);
    });

    it('admits the exact portable production proof/provenance owners while keeping other runner imports closed', () => {
        const consumer = path.join(packageRoot, 'baseline/observation/validate-rtc-b06-production-serving-proof.ts');
        for (const fixture of productionFixturePaths) {
            expect(isApprovedImport(consumer, path.relative(path.dirname(consumer), fixture))).toBe(true);
            const dependencies = fixture.endsWith('/full-stack-rtc-production-proof.ts')
                ? ['../../../../shared/api/api-json-value.ts', '../../../../shared/resilience/Either.ts']
                : [];
            expect(parseImportSpecifiers(fs.readFileSync(fixture, 'utf8'))).toEqual(dependencies);
        }
        expect(isApprovedImport(consumer, '../../../shared-test/black-box-runner/fixtures/rtc-production/read-full-stack-rtc-build-tool-inputs.ts')).toBe(
            false
        );
        expect(isApprovedImport(consumer, '../../../shared-test/black-box-runner/rallar-in-memory-runtime.ts')).toBe(false);
    });

    it('admits only the portable browser recording contract and its canonical JSON dependency', () => {
        const consumer = path.join(packageRoot, 'baseline/acceptance/validate-rtc-b06-browser-recording.ts');
        const recording = path.join(repoRoot, 'packages/shared-test/black-box-runner/fixtures/browser-diagnostics-recording.ts');
        expect(isApprovedImport(consumer, path.relative(path.dirname(consumer), recording))).toBe(true);
        expect(parseImportSpecifiers(fs.readFileSync(recording, 'utf8'))).toEqual([
            '../../../shared/api/api-json-value.ts'
        ]);
        for (
            const forbidden of [
                'rallar-bb-test/browser/browser-command-contracts.ts',
                'rallar-bb-test/browser/diagnostic-recording/to-browser-diagnostics-receipt.ts',
                'rallar-bb-test/browser-control-agent/to-rallar-black-box-routine-browser-diagnostics.ts',
                'rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts',
                'black-box-runner/rallar-in-memory-runtime.ts',
                'black-box-runner/fixtures/another-contract.ts'
            ]
        ) {
            expect(isApprovedImport(consumer, `../../../shared-test/${forbidden}`)).toBe(false);
        }
        expect(isApprovedImport(consumer, '@shared-test/black-box-runner/fixtures/browser-diagnostics-recording.ts')).toBe(false);
    });

    it('admits only the canonical event history owner while keeping other shared-test and app imports closed', () => {
        const consumer = path.join(packageRoot, 'baseline/acceptance/to-rtc-b06-event-history.ts');
        expect(isApprovedImport(consumer, path.relative(path.dirname(consumer), eventHistoryOwnerPath))).toBe(true);
        for (
            const forbidden of [
                'runtime/decode-runtime-result-values.ts',
                'runtime/execute-runtime-command.ts',
                'rallar-black-box-test-contracts.ts',
                'control-protocol.ts',
                'browser/create-rallar-black-box-browser-test-runtime.ts',
                'create-rallar-black-box-test-runtime.ts'
            ]
        ) {
            expect(isApprovedImport(consumer, `../../../shared-test/rallar-bb-test/${forbidden}`)).toBe(false);
        }
        expect(isApprovedImport(consumer, '@shared-test/rallar-bb-test/runtime/event-history.ts')).toBe(false);
        expect(isApprovedImport(consumer, '../../../apps/rallar-black-box/event-history.ts')).toBe(false);
    });

    it('scans performance script roots that exist', () => {
        expect(performanceScriptRoots.filter((root) => !fs.existsSync(path.join(repoRoot, root)))).toEqual([]);
    });

    it('owns every RTC/WebRTC performance source outside scripts', () => {
        const oldSources = readRtcPerformanceScriptSources().map((file) => path.relative(repoRoot, file));
        expect(oldSources, `old RTC/WebRTC performance sources:\n${oldSources.join('\n')}`).toEqual([]);
    });

    it('allows test integration while rejecting product and misleading test-prefix consumers', () => {
        const testFile = path.join(repoRoot, 'packages/tests/rallar-black-box/live-rtc-durable-journal.test.ts');
        const owner = path.join(packageRoot, 'baseline/evidence/rtc-baseline-file-port.ts');
        expect(isForbiddenBenchmarkImport(testFile, path.relative(path.dirname(testFile), owner))).toBe(false);
        expect(isForbiddenBenchmarkImport(testFile, `${benchmarkPackageName}/baseline/evidence`)).toBe(false);
        for (
            const productPath of [
                'packages/shared-web/browser/product.ts',
                'apps/rallar-black-box/src/product.ts',
                'packages/tests-other/product.test.ts',
                'packages/shared-rtc-bench-other/product.ts',
                'packages/tests/product.ts'
            ]
        ) {
            const productFile = path.join(repoRoot, productPath);
            expect(isForbiddenBenchmarkImport(productFile, path.relative(path.dirname(productFile), owner))).toBe(true);
            expect(isForbiddenBenchmarkImport(productFile, `${benchmarkPackageName}/baseline/evidence`)).toBe(true);
            expect(isForbiddenBenchmarkImport(productFile, `${benchmarkPackageName}-other/baseline/evidence`)).toBe(false);
        }
    });

    it('has no prohibited package imports or reverse product imports', () => {
        const packageViolations = [...readFilesBelow(packageRoot), ...readRtcPerformanceScriptSources()]
            .filter((file) => /\.[cm]?[jt]s$/.test(file))
            .flatMap(readUnapprovedImports);
        const reverseImports = [path.join(repoRoot, 'apps'), path.join(repoRoot, 'packages')]
            .flatMap(readFilesBelow)
            .filter((file) => !file.startsWith(`${packageRoot}${path.sep}`) && /\.[cm]?[jt]s$/.test(file))
            .filter(readBenchmarkPackageUsage)
            .map((file) => path.relative(repoRoot, file));
        expect([...packageViolations, ...reverseImports]).toEqual([]);
    });
});
