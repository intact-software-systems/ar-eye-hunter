import { spawn } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
    assertExperienceChunkGraph,
    readExperienceChunkGraph,
    type ExperienceChunkGraph
} from '../../../apps/rallar-black-box/scripts/assert-experience-chunks.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const appRoot = join(repoRoot, 'apps/rallar-black-box');
const assertionScript = join(appRoot, 'scripts/assert-experience-chunks.ts');
const temporaryDirectories: string[] = [];

interface TestManifestChunk {
    file: string;
    src?: string;
    imports?: string[];
    dynamicImports?: string[];
}

type TestManifest = Record<string, TestManifestChunk>;

interface BuiltExperienceFixture {
    readonly outputRoot: string;
    readonly graph: ExperienceChunkGraph;
    readonly manifestPath: string;
    readonly manifest: TestManifest;
}

function run(command: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolveRun, reject) => {
        const child = spawn(command, args, {
            cwd,
            env: process.env,
            stdio: 'pipe'
        });
        let output = '';
        child.stdout.on('data', (chunk) => {
            output += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
            output += String(chunk);
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) {
                resolveRun();
                return;
            }
            reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${output}`));
        });
    });
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

test('ships mutually exclusive Recipe Console and workbench experience chunks', async () => {
    const fixture = await buildExperienceFixture();
    assertExperienceGraph(fixture.graph);
    await assertWorkbenchDynamicFailures(fixture);
    await assertWorkbenchStatefulFailure(fixture);
    await assertRecipeConsoleFailures(fixture);
    await assertTuneFailure(fixture);
});

async function buildExperienceFixture(): Promise<BuiltExperienceFixture> {
    await expect(access(assertionScript)).resolves.toBeUndefined();
    const outputRoot = await mkdtemp(join(tmpdir(), 'rallar-experience-build-'));
    temporaryDirectories.push(outputRoot);
    await run(
        join(repoRoot, 'node_modules/.bin/vite'),
        ['build', '--outDir', outputRoot, '--emptyOutDir'],
        appRoot
    );
    await run(process.execPath, [assertionScript, outputRoot], repoRoot);
    const manifestPath = join(outputRoot, '.vite/manifest.json');
    return {
        outputRoot,
        graph: readExperienceChunkGraph(manifestPath),
        manifestPath,
        manifest: JSON.parse(await readFile(manifestPath, 'utf8')) as TestManifest
    };
}

function assertExperienceGraph(graph: ExperienceChunkGraph): void {
    expect(graph.main).toBe('index.html');
    expect(graph.mainStaticClosure.size).toBeGreaterThan(1);
    expect(graph.mainDynamicEntries.size).toBeGreaterThan(2);
    expect([...graph.mainDynamicExperienceEntries]).toEqual([
        'src/recipe-console/app/RecipeConsoleApp.tsx',
        'src/workbench/workbench-experience.tsx'
    ]);
    expect(graph.recipeConsoleStaticClosure.size).toBeGreaterThan(1);
    expect(graph.workbenchStaticClosure.size).toBeGreaterThan(1);
    expect([...graph.workbenchSafeDynamicEntries.keys()]).toEqual([
        'RunnerRecipesPanel',
        'RunnerRunsPanel',
        'RunnerFleetPanel',
        'FlowBuilderPanel',
        'DistributedRecipesPanel',
        'RunManagerPanel',
        'SharedTestPanel',
        'RoomsClientsPanel',
        'TopologyGraphPanel',
        'RtcDiagnosticsPanel'
    ]);
    expect(graph.workbenchDynamicClosure.size).toBeGreaterThan(graph.workbenchStaticClosure.size);
    for (const entry of graph.workbenchSafeDynamicEntries.values()) {
        expect(graph.mainStaticClosure.has(entry)).toBe(false);
        expect(graph.workbenchStaticClosure.has(entry)).toBe(false);
        expect(graph.recipeConsoleStaticClosure.has(entry)).toBe(false);
        expect(graph.workbenchDynamicClosure.has(entry)).toBe(true);
        expect(graph.productionClosure.has(entry)).toBe(true);
    }
    expect(graph.retentionDynamicEntry).toBe('src/recipe-console/control/control-retention-api.ts');
    expect(graph.retentionStaticClosure.size).toBeGreaterThan(1);
    expect(graph.tuneStaticClosure.has(graph.retentionDynamicEntry)).toBe(false);
    expect(graph.recipeConsoleStaticClosure.has(graph.retentionDynamicEntry)).toBe(false);
    expect(graph.productionClosure.size).toBeGreaterThan(graph.mainStaticClosure.size);
    expect([...graph.productionClosure].some((key) => key.includes('recipe-console-css-isolation'))).toBe(false);
    expect(() => assertExperienceChunkGraph(graph)).not.toThrow();
}

async function assertWorkbenchDynamicFailures(fixture: BuiltExperienceFixture): Promise<void> {
    const workbenchEntry = Object.entries(fixture.manifest).find(([, entry]) => entry.src?.endsWith('/workbench/workbench-experience.tsx'));
    expect(workbenchEntry).toBeDefined();
    for (const [label, safeEntry] of fixture.graph.workbenchSafeDynamicEntries) {
        const withStaticLeak = structuredClone(fixture.manifest);
        const workbenchChunk = withStaticLeak[workbenchEntry?.[0] ?? 'missing'];
        if (!workbenchChunk) {
            throw new Error('Workbench manifest entry is unavailable.');
        }
        workbenchChunk.imports = [...workbenchChunk.imports ?? [], safeEntry];
        await writeFile(fixture.manifestPath, JSON.stringify(withStaticLeak));
        expect(
            () => assertExperienceChunkGraph(readExperienceChunkGraph(fixture.manifestPath)),
            `${label}: forced Workbench static import`
        ).toThrow(new RegExp(`Workbench static closure includes safe workbench entry ${label}`));

        const withUnreachableEntry = structuredClone(fixture.manifest);
        for (const chunk of Object.values(withUnreachableEntry)) {
            chunk.imports = chunk.imports?.filter((entry) => entry !== safeEntry);
            chunk.dynamicImports = chunk.dynamicImports?.filter((entry) => entry !== safeEntry);
        }
        await writeFile(fixture.manifestPath, JSON.stringify(withUnreachableEntry));
        expect(
            () => assertExperienceChunkGraph(readExperienceChunkGraph(fixture.manifestPath)),
            `${label}: disconnected production entry`
        ).toThrow(new RegExp(`Workbench safe dynamic entry ${label} is not production-reachable`));
    }
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
}

async function assertWorkbenchStatefulFailure(fixture: BuiltExperienceFixture): Promise<void> {
    const chunks = await Promise.all(
        [...fixture.graph.workbenchStaticClosure].map(async (key) => {
            const path = join(fixture.outputRoot, fixture.manifest[key]?.file ?? 'missing');
            return { path, text: await readFile(path, 'utf8') };
        })
    );
    const ownerChunk = chunks.find(({ text }) => text.includes('quick-rallar-test-panel'));
    expect(ownerChunk).toBeDefined();
    await writeFile(
        ownerChunk?.path ?? 'missing',
        (ownerChunk?.text ?? '').replaceAll('quick-rallar-test-panel', 'missing-quick-owner')
    );
    expect(() => assertExperienceChunkGraph(readExperienceChunkGraph(fixture.manifestPath)))
        .toThrow(/Workbench static closure is missing the Quick Rallar Test stateful diagnostic/);
    await writeFile(ownerChunk?.path ?? 'missing', ownerChunk?.text ?? '');
}

async function assertRecipeConsoleFailures(fixture: BuiltExperienceFixture): Promise<void> {
    const recipeChunk = Object.values(fixture.manifest).find((entry) => entry.src?.endsWith('/recipe-console/app/RecipeConsoleApp.tsx'));
    const workerClientEntry = Object.entries(fixture.manifest).find(([, entry]) => entry.src?.endsWith('/recipe-console/analyze/analyze-worker-client.ts'));
    const workerFactoryEntry = Object.entries(fixture.manifest).find(([, entry]) => entry.src?.endsWith('/recipe-console/analyze/analyze-worker-factory.ts'));
    expect(recipeChunk).toBeDefined();
    expect(workerClientEntry).toBeDefined();
    expect(workerFactoryEntry).toBeDefined();
    expect(fixture.graph.recipeConsoleStaticClosure.has(workerClientEntry?.[0] ?? 'missing')).toBe(false);
    expect(fixture.graph.recipeConsoleStaticClosure.has(workerFactoryEntry?.[0] ?? 'missing')).toBe(false);
    expect(await readdir(join(fixture.outputRoot, 'assets'))).toEqual(
        expect.arrayContaining([expect.stringMatching(/^analyze-artifact\.worker-[^.]+\.js$/)])
    );
    const recipeChunkPath = join(fixture.outputRoot, recipeChunk?.file ?? 'missing');
    const recipeChunkText = await readFile(recipeChunkPath, 'utf8');
    expect(recipeChunkText).toContain('data-command-bar');
    await writeFile(recipeChunkPath, recipeChunkText.replaceAll('data-command-bar', 'corrupted-command-bar'));
    expect(() => assertExperienceChunkGraph(readExperienceChunkGraph(fixture.manifestPath)))
        .toThrow(/Recipe Console static closure sentinel is missing/);
    await writeFile(recipeChunkPath, recipeChunkText);
}

async function assertTuneFailure(fixture: BuiltExperienceFixture): Promise<void> {
    const tuneChunk = Object.values(fixture.manifest).find((entry) => entry.src?.endsWith('/recipe-console/tune/TuneWorkspace.tsx'));
    expect(tuneChunk).toBeDefined();
    const tuneChunkPath = join(fixture.outputRoot, tuneChunk?.file ?? 'missing');
    const tuneChunkText = await readFile(tuneChunkPath, 'utf8');
    expect(tuneChunkText).toContain('data-history-workspace');
    await writeFile(
        tuneChunkPath,
        tuneChunkText.replaceAll('data-history-workspace', 'corrupted-history-workspace')
    );
    expect(() => assertExperienceChunkGraph(readExperienceChunkGraph(fixture.manifestPath)))
        .toThrow(/Tune static closure History sentinels are missing/);
}
