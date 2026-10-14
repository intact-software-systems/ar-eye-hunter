import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    createFullStackRtcPreviewServer,
    prepareFullStackRtcProduction,
    readFullStackRtcProductionSeal
} from '../../../apps/rallar-black-box/playwright-full-stack-spa-server.ts';
import type { LiveRtcPerformanceAttemptContext } from '../../../tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts';

const roots: string[] = [];
const baselineId = '20261010T100000Z-aaaaaaaaaaaa-e3-memory-gh123-a1';
const locator = {
    workloadId: 'RTC-B06',
    caseId: 'default',
    inputKey: 'e3-memory-default',
    intendedPhase: 'retained',
    outerOrdinal: 1,
    environmentId: 'E3-memory',
    rawResultRelativePath: 'artifacts/staging/a.json'
} as const;
const caseKey = { workloadId: 'RTC-B06', caseId: 'default', inputKey: 'e3-memory-default' } as const;
const source = Buffer.from('source bytes');
const index = '<script type="module" src="/assets/entry.js"></script>';
const manifest = { 'index.html': { file: 'assets/entry.js', isEntry: true } };
const observation: LiveRtcPerformanceAttemptContext['runtimeObservation'] = {
    git: { headCommit: 'a'.repeat(40), headTree: 'b'.repeat(40), ref: 'codex/fixture', clean: true },
    runtime: { node: 'v24', npm: '11', deno: '2', playwright: '1', chromium: '149' },
    host: { os: 'linux', kernel: '1', architecture: 'x64', logicalCpuCount: 4, cpuModel: 'fixture', totalMemoryBytes: 1, executionContext: 'local' },
    timing: { startedAtUtc: '2026-10-10T10:00:00.000Z', endedAtUtc: '2026-10-10T10:00:01.000Z', monotonicDurationMs: 1000, monotonicSource: 'performance.now' },
    deviations: [],
    sourceHashes: [{ path: 'source.ts', kind: 'source', sha256: createHash('sha256').update(source).digest('hex') }],
    configurationInputs: [],
    controllerInputs: [{ name: 'baselineId', value: baselineId, secret: false }],
    allowlistedEnvironment: {},
    resolvedConfiguration: ['appServingMode', 'viteMode', 'nodeEnvironment', 'buildTarget'].map((field) => ({
        caseKey,
        field,
        value: field === 'buildTarget' ? 'es2023' : 'production',
        source: 'default'
    })),
    workerCommand: { redactedArgv: { executable: 'npm', arguments: [] }, projection: { fixedWorkerFlags: [], configurationFlags: [] } }
};

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function preparationFixture(outerOrdinal = 1, entrySource = 'export const value = 42;') {
    const repoRoot = await mkdtemp(join(tmpdir(), 'rtc-production-'));
    roots.push(repoRoot);
    const buildRoot = join(repoRoot, 'tmp/perf/rtc-b06-private-build', baselineId, `default/retained-${outerOrdinal}`);
    await mkdir(join(buildRoot, 'output'), { recursive: true });
    await writeFile(join(buildRoot, 'owner.json'), JSON.stringify({ baselineId, attempt: { ...locator, outerOrdinal } }));
    await writeFile(join(repoRoot, 'source.ts'), source);
    const attempt = { repoRoot, baselineId, locator: { ...locator, outerOrdinal }, runtimeObservation: observation };
    const configuration = {
        buildRoot,
        apiBaseUrl: 'http://localhost:18080',
        spaBaseUrl: 'http://localhost:5177',
        environment: { NODE_ENV: 'production', VITE_PRIVATE: 'never serialize' }
    };
    const commands: string[][] = [];
    const dependencies = {
        readBuildToolInputs: async () => ['source.ts'],
        async readGit() {
            return observation.git;
        },
        async build(arguments_: readonly string[], environment: Readonly<Record<string, string | undefined>>) {
            commands.push([...arguments_]);
            expect(environment.VITE_PRIVATE).toBe('never serialize');
            await mkdir(join(buildRoot, 'output/.vite'));
            await mkdir(join(buildRoot, 'output/assets'));
            await writeFile(join(buildRoot, 'output/index.html'), index);
            await writeFile(join(buildRoot, 'output/.vite/manifest.json'), JSON.stringify(manifest));
            await writeFile(join(buildRoot, 'output/assets/entry.js'), entrySource);
            return 0;
        }
    };
    return { repoRoot, buildRoot, attempt, configuration, commands, dependencies };
}

describe('full-stack RTC production preparation', () => {
    it('permits a fresh owned empty output, then seals original build bytes before returning server configuration', async () => {
        const fixture = await preparationFixture();
        const prepared = await prepareFullStackRtcProduction(fixture.attempt, fixture.configuration, fixture.dependencies);
        expect(prepared.left).toBeUndefined();
        expect(prepared.right?.appServingMode).toBe('production');
        expect(fixture.commands).toEqual([[
            '--workspace',
            'rallar-black-box',
            'run',
            'build',
            '--',
            '--outDir',
            join(fixture.buildRoot, 'output'),
            '--emptyOutDir',
            '--mode',
            'production',
            '--target',
            'es2023'
        ]]);
        const server = createFullStackRtcPreviewServer(prepared.right!);
        expect(server).toMatchObject({ url: 'http://localhost:5177', timeout: 60000, reuseExistingServer: false });
        expect(server.command).toContain('rtc-production-preview');
        const seal = JSON.parse(await readFile(join(fixture.buildRoot, 'seal.json'), 'utf8'));
        expect(seal.baselineId).toBe(baselineId);
        expect(seal.attempt).toEqual(locator);
        expect(seal.files.map((file: { path: string; }) => file.path)).toEqual(['.vite/manifest.json', 'assets/entry.js', 'index.html']);
        expect(JSON.stringify(seal)).not.toContain('never serialize');
    });

    it.each(['failed', 'absent', 'occupied', 'unowned', 'mode', 'source', 'escaping', 'symlink', 'tool-mismatch'] as const)(
        'denies %s preparation before any server is returned',
        async (failure) => {
            const fixture = await preparationFixture();
            if (failure === 'occupied') {
                await writeFile(join(fixture.buildRoot, 'output/unowned.js'), 'occupied');
            }
            if (failure === 'unowned') {
                await rm(join(fixture.buildRoot, 'owner.json'));
            }
            if (failure === 'source') {
                await writeFile(join(fixture.repoRoot, 'source.ts'), 'tampered');
            }
            if (failure === 'symlink') {
                await rm(join(fixture.buildRoot, 'output'), { recursive: true });
                await symlink(tmpdir(), join(fixture.buildRoot, 'output'));
            }
            const configuration = failure === 'mode'
                ? { ...fixture.configuration, environment: { NODE_ENV: 'development' } }
                : failure === 'escaping'
                ? { ...fixture.configuration, buildRoot: tmpdir() }
                : fixture.configuration;
            const dependencies = failure === 'tool-mismatch'
                ? { ...fixture.dependencies, readBuildToolInputs: async () => ['node_modules/other-native.node'] }
                : failure === 'failed'
                ? { ...fixture.dependencies, build: async () => 7 }
                : failure === 'absent'
                ? { ...fixture.dependencies, build: async () => 0 }
                : fixture.dependencies;
            const prepared = await prepareFullStackRtcProduction(fixture.attempt, configuration, dependencies);
            expect(prepared.right).toBeUndefined();
            expect(prepared.left?.code).toBeTruthy();
            expect(fixture.commands).toEqual([]);
        }
    );

    it('keeps successive output hashes and locations outside unchanged initialized mode and input identity', async () => {
        const first = await preparationFixture(1);
        const second = await preparationFixture(2, 'export const value = 43;');
        const preparedFirst = await prepareFullStackRtcProduction(first.attempt, first.configuration, first.dependencies);
        const preparedSecond = await prepareFullStackRtcProduction(second.attempt, second.configuration, second.dependencies);
        expect(preparedFirst.right?.attempt.outerOrdinal).toBe(1);
        expect(preparedSecond.right?.attempt.outerOrdinal).toBe(2);
        expect(preparedSecond.right?.buildRoot).not.toBe(preparedFirst.right?.buildRoot);
        expect(preparedSecond.right?.files.find((file) => file.path === 'assets/entry.js')?.sha256).not.toBe(
            preparedFirst.right?.files.find((file) => file.path === 'assets/entry.js')?.sha256
        );
        expect(preparedSecond.right?.inputFiles).toEqual(preparedFirst.right?.inputFiles);
        expect(second.attempt.runtimeObservation).toEqual(first.attempt.runtimeObservation);
    });

    it('rejects completed-output tamper before the preview child can launch', async () => {
        const fixture = await preparationFixture();
        await prepareFullStackRtcProduction(fixture.attempt, fixture.configuration, fixture.dependencies);
        expect((await readFullStackRtcProductionSeal(fixture.attempt, fixture.configuration, fixture.dependencies)).right).toBeDefined();
        await writeFile(join(fixture.buildRoot, 'output/assets/entry.js'), 'tampered');
        const seal = await readFullStackRtcProductionSeal(fixture.attempt, fixture.configuration, fixture.dependencies);
        expect(seal.right).toBeUndefined();
        expect(seal.left?.code).toBe('production-binding-invalid');
    });
});

describe('production served-byte admission', () => {
    it('accepts exact served bytes and strips every request query from the browser entry binding', async () => {
        const fixture = await preparationFixture();
        const prepared = await prepareFullStackRtcProduction(fixture.attempt, fixture.configuration, fixture.dependencies);
        const { readFullStackRtcServedBuild, toFullStackRtcBrowserEntry } = await import('../../../apps/rallar-black-box/rtc-production-serving-proof.ts');
        const served = await readFullStackRtcServedBuild(prepared.right!, async (url) => {
            const path = new URL(url).pathname === '/' ? 'index.html' : new URL(url).pathname.slice(1);
            return { status: 200, bytes: await readFile(join(fixture.buildRoot, 'output', path)) };
        });
        expect(served.left).toBeUndefined();
        expect(served.right?.servedFiles.map((file) => file.path)).toEqual(['assets/entry.js', 'index.html']);
        const entry = toFullStackRtcBrowserEntry(served.right!, {
            prefix: 'A',
            url: 'http://localhost:5177/?password=secret&room=private',
            status: 200,
            bytes: Buffer.from(index)
        });
        expect(entry.right).toMatchObject({ prefix: 'A', path: 'index.html' });
        expect(JSON.stringify(entry)).not.toMatch(/secret|password|room=private/);
    });

    it('denies a healthy listener serving different bytes', async () => {
        const fixture = await preparationFixture();
        const prepared = await prepareFullStackRtcProduction(fixture.attempt, fixture.configuration, fixture.dependencies);
        const { readFullStackRtcServedBuild } = await import('../../../apps/rallar-black-box/rtc-production-serving-proof.ts');
        const served = await readFullStackRtcServedBuild(prepared.right!, async () => ({ status: 200, bytes: Buffer.from('wrong bytes') }));
        expect(served.right).toBeUndefined();
        expect(served.left?.code).toBe('served-bytes-mismatch');
    });
});
