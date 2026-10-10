import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import {
    decodeFullStackRtcBuildToolInputs,
    FULL_STACK_RTC_BUILD_TOOL_INPUT_COMMAND
} from '../../packages/shared-test/black-box-runner/fixtures/rtc-production/full-stack-rtc-build-tool-provenance.ts';
import {
    decodeProductionSeal,
    FULL_STACK_RTC_PRODUCTION_POLICY,
    type FullStackRtcProductionFile,
    type FullStackRtcProductionSeal
} from '../../packages/shared-test/black-box-runner/fixtures/rtc-production/full-stack-rtc-production-proof.ts';
import { Either } from '../../packages/shared/resilience/Either.ts';
import type { LiveRtcPerformanceAttemptContext } from '../../tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts';

export interface FullStackRtcProductionAttempt {
    readonly repoRoot: string;
    readonly baselineId: string;
    readonly locator: LiveRtcPerformanceAttemptContext['locator'];
    readonly runtimeObservation: LiveRtcPerformanceAttemptContext['runtimeObservation'];
}

export interface FullStackRtcProductionConfiguration {
    readonly buildRoot: string;
    readonly apiBaseUrl: string;
    readonly spaBaseUrl: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface FullStackRtcProductionDependencies {
    readBuildToolInputs(): Promise<readonly string[]>;
    readGit(): Promise<LiveRtcPerformanceAttemptContext['runtimeObservation']['git']>;
    build(arguments_: readonly string[], environment: Readonly<Record<string, string | undefined>>): Promise<number>;
}

export interface FullStackRtcProductionServerConfiguration {
    readonly command: string;
    readonly env: Readonly<Record<string, string>>;
    readonly url: string;
    readonly reuseExistingServer: false;
    readonly timeout: 60000;
}

export interface FullStackRtcProductionFailure {
    readonly code: 'production-binding-invalid' | 'production-build-failed';
    readonly message: string;
}

const runFile = promisify(execFile);
export async function prepareFullStackRtcProduction(
    attempt: FullStackRtcProductionAttempt,
    configuration: FullStackRtcProductionConfiguration,
    dependencies: FullStackRtcProductionDependencies
): Promise<Either<FullStackRtcProductionFailure, FullStackRtcProductionSeal>> {
    const issues = validateFullStackRtcProductionConfiguration(attempt, configuration);
    if (issues.length > 0) {
        return productionFailure('production-binding-invalid');
    }
    try {
        await readProductionOwner(attempt, configuration);
        if ((await readdir(resolve(configuration.buildRoot, 'output'))).length > 0) {
            return productionFailure('production-binding-invalid');
        }
        await readProductionInputs(attempt);
        await readBoundProductionBuildTools(attempt, dependencies);
        const git = await dependencies.readGit();
        if (JSON.stringify(git) !== JSON.stringify(attempt.runtimeObservation.git)) {
            return productionFailure('production-binding-invalid');
        }
        const buildArguments = toProductionBuildArguments(configuration.buildRoot);
        const privateEnvironment = {
            ...configuration.environment,
            NODE_ENV: 'production',
            VITE_RALLAR_API_BASE_URL: configuration.apiBaseUrl
        };
        if (await dependencies.build(buildArguments, privateEnvironment) !== 0) {
            return productionFailure('production-build-failed');
        }
        await readProductionInputs(attempt);
        await readBoundProductionBuildTools(attempt, dependencies);
        return Either.ofRight(
            await writeCompletedProductionSeal(attempt, configuration, { git, arguments: buildArguments })
        );
    }
    catch {
        return productionFailure('production-binding-invalid');
    }
}

export function createDefaultFullStackRtcProductionDependencies(repoRoot: string): FullStackRtcProductionDependencies {
    return {
        readBuildToolInputs: async () => {
            const output = await runFile('node', [...FULL_STACK_RTC_BUILD_TOOL_INPUT_COMMAND], { cwd: repoRoot });
            const paths = decodeFullStackRtcBuildToolInputs(JSON.parse(output.stdout));
            if (!paths) {
                throw new Error('Selected build-tool owners could not be bound.');
            }
            return paths;
        },
        readGit: async () => {
            const git = async (arguments_: readonly string[]) =>
                (await runFile('git', [...arguments_], { cwd: repoRoot })).stdout.trim();
            const headCommit = await git(['rev-parse', 'HEAD']);
            return {
                headCommit,
                headTree: await git(['rev-parse', 'HEAD^{tree}']),
                ref: (await git(['branch', '--show-current'])) || `detached@${headCommit}`,
                clean: (await git(['status', '--porcelain=v1'])).length === 0
            };
        },
        build: async (arguments_, environment) => {
            try {
                await runFile('npm', [...arguments_], { cwd: repoRoot, env: environment, maxBuffer: 16 * 1024 * 1024 });
                return 0;
            }
            catch {
                return 1;
            }
        }
    };
}

export async function readFullStackRtcProductionSeal(
    attempt: FullStackRtcProductionAttempt,
    configuration: FullStackRtcProductionConfiguration,
    dependencies: Pick<FullStackRtcProductionDependencies, 'readGit' | 'readBuildToolInputs'> =
        createDefaultFullStackRtcProductionDependencies(attempt.repoRoot)
): Promise<Either<FullStackRtcProductionFailure, FullStackRtcProductionSeal>> {
    if (validateFullStackRtcProductionConfiguration(attempt, configuration).length > 0) {
        return productionFailure('production-binding-invalid');
    }
    try {
        await readProductionOwner(attempt, configuration);
        await readProductionInputs(attempt);
        await readBoundProductionBuildTools(attempt, dependencies);
        await readConfinedProductionPath(attempt.repoRoot, resolve(configuration.buildRoot, 'seal.json'), 'file');
        if (JSON.stringify(await dependencies.readGit()) !== JSON.stringify(attempt.runtimeObservation.git)) {
            return productionFailure('production-binding-invalid');
        }
        const raw: unknown = JSON.parse(await readFile(resolve(configuration.buildRoot, 'seal.json'), 'utf8'));
        const decoded = decodeProductionSeal(raw);
        if (!decoded) {
            return productionFailure('production-binding-invalid');
        }
        const files = await readProductionOutput(configuration.buildRoot);
        const entryFiles = await readProductionEntryFiles(configuration.buildRoot, files);
        if (
            decoded.baselineId !== attempt.baselineId || decoded.buildRoot !== configuration.buildRoot ||
            JSON.stringify(decoded.attempt) !== JSON.stringify(attempt.locator) ||
            JSON.stringify(decoded.git) !== JSON.stringify(attempt.runtimeObservation.git) ||
            JSON.stringify(decoded.inputFiles) !== JSON.stringify(attempt.runtimeObservation.sourceHashes) ||
            decoded.apiOrigin !== new URL(configuration.apiBaseUrl).origin ||
            decoded.spaOrigin !== new URL(configuration.spaBaseUrl).origin ||
            JSON.stringify(decoded.files) !== JSON.stringify(files) ||
            JSON.stringify(decoded.entryFiles) !== JSON.stringify(entryFiles) ||
            JSON.stringify(decoded.buildArguments) !==
                JSON.stringify(toProductionBuildArguments(configuration.buildRoot))
        ) {
            return productionFailure('production-binding-invalid');
        }
        return Either.ofRight(decoded);
    }
    catch {
        return productionFailure('production-binding-invalid');
    }
}

export function createFullStackRtcPreviewServer(
    seal: FullStackRtcProductionSeal
): FullStackRtcProductionServerConfiguration {
    return {
        command: `cd ../.. && node --import tsx apps/rallar-black-box/scripts/rtc-production-preview.ts`,
        env: {
            RALLAR_BLACK_BOX_RTC_BUILD_ROOT: seal.buildRoot,
            VITE_RALLAR_API_BASE_URL: seal.apiOrigin,
            VITE_RALLAR_SPA_BASE_URL: seal.spaOrigin,
            NODE_ENV: 'production'
        },
        url: seal.spaOrigin,
        reuseExistingServer: false,
        timeout: 60_000
    };
}

export function validateFullStackRtcProductionConfiguration(
    attempt: FullStackRtcProductionAttempt,
    configuration: FullStackRtcProductionConfiguration
): readonly string[] {
    const issues: string[] = [];
    for (const [field, value] of Object.entries(FULL_STACK_RTC_PRODUCTION_POLICY)) {
        const selected = attempt.runtimeObservation.resolvedConfiguration.find((entry) =>
            entry.caseKey.inputKey === attempt.locator.inputKey && entry.caseKey.caseId === attempt.locator.caseId &&
            entry.field === field
        );
        if (selected?.value !== value) {
            issues.push(field);
        }
    }
    if (configuration.environment.NODE_ENV !== 'production') {
        issues.push('node-environment');
    }
    for (const value of [configuration.apiBaseUrl, configuration.spaBaseUrl]) {
        try {
            const url = new URL(value);
            if (
                !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
                !['', '/'].includes(url.pathname)
            ) {
                issues.push('unsafe-origin');
            }
        }
        catch {
            issues.push('unsafe-origin');
        }
    }
    const expected = resolve(
        attempt.repoRoot,
        'tmp/perf/rtc-b06-private-build',
        attempt.baselineId,
        attempt.locator.caseId,
        `${attempt.locator.intendedPhase}-${attempt.locator.outerOrdinal}`
    );
    if (
        !/^[a-zA-Z0-9-]+$/.test(attempt.baselineId) ||
        !['default', 'all-scenarios', 'retention-100'].includes(attempt.locator.caseId) ||
        !['warmup', 'retained'].includes(attempt.locator.intendedPhase) ||
        !Number.isSafeInteger(attempt.locator.outerOrdinal) || attempt.locator.outerOrdinal < 1
    ) {
        issues.push('invalid-attempt');
    }
    if (configuration.buildRoot !== expected) {
        issues.push('unowned-output');
    }
    return issues;
}

function toProductionBuildArguments(buildRoot: string): readonly string[] {
    return [
        '--workspace',
        'rallar-black-box',
        'run',
        'build',
        '--',
        '--outDir',
        resolve(buildRoot, 'output'),
        '--emptyOutDir',
        '--mode',
        'production',
        '--target',
        'es2023'
    ];
}

async function writeCompletedProductionSeal(
    attempt: FullStackRtcProductionAttempt,
    configuration: FullStackRtcProductionConfiguration,
    build: { git: LiveRtcPerformanceAttemptContext['runtimeObservation']['git']; arguments: readonly string[]; }
): Promise<FullStackRtcProductionSeal> {
    const files = await readProductionOutput(configuration.buildRoot);
    const entryFiles = await readProductionEntryFiles(configuration.buildRoot, files);
    const seal: FullStackRtcProductionSeal = {
        version: 1,
        ...FULL_STACK_RTC_PRODUCTION_POLICY,
        baselineId: attempt.baselineId,
        attempt: attempt.locator,
        buildRoot: configuration.buildRoot,
        apiOrigin: new URL(configuration.apiBaseUrl).origin,
        spaOrigin: new URL(configuration.spaBaseUrl).origin,
        git: build.git,
        inputFiles: attempt.runtimeObservation.sourceHashes,
        files,
        entryFiles,
        buildArguments: build.arguments
    };
    await writeFile(resolve(configuration.buildRoot, 'seal.json'), JSON.stringify(seal), { flag: 'wx' });
    return seal;
}

async function readBoundProductionBuildTools(
    attempt: FullStackRtcProductionAttempt,
    dependencies: Pick<FullStackRtcProductionDependencies, 'readBuildToolInputs'>
): Promise<void> {
    const selected = await dependencies.readBuildToolInputs();
    if (!selected.every((path) => attempt.runtimeObservation.sourceHashes.some((file) => file.path === path))) {
        throw new Error('Selected installed build tools differ from initialized inputs.');
    }
}

async function readProductionOwner(
    attempt: FullStackRtcProductionAttempt,
    configuration: FullStackRtcProductionConfiguration
): Promise<void> {
    await readConfinedProductionPath(attempt.repoRoot, configuration.buildRoot, 'directory');
    await readConfinedProductionPath(attempt.repoRoot, resolve(configuration.buildRoot, 'output'), 'directory');
    await readConfinedProductionPath(attempt.repoRoot, resolve(configuration.buildRoot, 'owner.json'), 'file');
    const owner: unknown = JSON.parse(await readFile(resolve(configuration.buildRoot, 'owner.json'), 'utf8'));
    if (JSON.stringify(owner) !== JSON.stringify({ baselineId: attempt.baselineId, attempt: attempt.locator })) {
        throw new Error('Unowned production output.');
    }
}

async function readProductionInputs(attempt: FullStackRtcProductionAttempt): Promise<void> {
    for (const file of attempt.runtimeObservation.sourceHashes) {
        const path = resolve(attempt.repoRoot, file.path);
        await readConfinedProductionPath(attempt.repoRoot, path, 'file');
        if (createHash('sha256').update(await readFile(path)).digest('hex') !== file.sha256) {
            throw new Error('Production source inputs changed.');
        }
    }
}

async function readConfinedProductionPath(root: string, path: string, kind: 'file' | 'directory'): Promise<void> {
    const confined = relative(root, path);
    if (isAbsolute(confined) || confined.startsWith(`..${sep}`) || confined === '..') {
        throw new Error('Escaping production path.');
    }
    let current = root;
    for (const segment of confined.split(sep).filter(Boolean)) {
        current = resolve(current, segment);
        const status = await lstat(current);
        if (status.isSymbolicLink()) {
            throw new Error('Symlinked production path.');
        }
    }
    const status = await lstat(path);
    if (
        (kind === 'file' && !status.isFile()) || (kind === 'directory' && !status.isDirectory()) ||
        await realpath(path) !== resolve(await realpath(root), confined)
    ) {
        throw new Error('Unsafe production path.');
    }
}

async function readProductionOutput(buildRoot: string): Promise<readonly FullStackRtcProductionFile[]> {
    const output = resolve(buildRoot, 'output');
    const files: FullStackRtcProductionFile[] = [];
    async function readDirectory(directory: string): Promise<void> {
        for (const name of (await readdir(directory)).sort()) {
            const path = resolve(directory, name);
            const status = await lstat(path);
            if (status.isSymbolicLink()) {
                throw new Error('Symlinked build output.');
            }
            if (status.isDirectory()) {
                await readDirectory(path);
            }
            else if (status.isFile()) {
                const bytes = await readFile(path);
                files.push({
                    path: relative(output, path).split(sep).join('/'),
                    sizeBytes: bytes.length,
                    sha256: createHash('sha256').update(bytes).digest('hex')
                });
            }
            else {
                throw new Error('Invalid build output.');
            }
        }
    }
    await readDirectory(output);
    return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readProductionEntryFiles(
    buildRoot: string,
    files: readonly FullStackRtcProductionFile[]
): Promise<readonly string[]> {
    const raw: unknown = JSON.parse(await readFile(resolve(buildRoot, 'output/.vite/manifest.json'), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid production manifest.');
    }
    const entries = Object.values(raw).filter((value) => value && typeof value === 'object' && value.isEntry === true);
    const entryFiles = entries.map((value) => value.file);
    const html = await readFile(resolve(buildRoot, 'output/index.html'), 'utf8');
    if (
        entryFiles.length === 0 ||
        entryFiles.some((path) =>
            typeof path !== 'string' || !files.some((file) => file.path === path) || !html.includes(path)
        )
    ) {
        throw new Error('Incomplete production manifest.');
    }
    return entryFiles.sort();
}

function productionFailure(code: FullStackRtcProductionFailure['code']): Either<FullStackRtcProductionFailure, never> {
    return Either.ofLeft({
        code,
        message: code === 'production-build-failed'
            ? 'Original production build failed.'
            : 'Production build ownership, configuration or bytes could not be verified.'
    });
}
