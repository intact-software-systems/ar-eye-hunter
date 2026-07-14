import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, test } from 'vitest';

import {
    assertExperienceChunkGraph,
    readExperienceChunkGraph,
} from '../../../apps/rallar-black-box/scripts/assert-experience-chunks.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const appRoot = join(repoRoot, 'apps/rallar-black-box');
const assertionScript = join(appRoot, 'scripts/assert-experience-chunks.ts');
const temporaryDirectories: string[] = [];

function run(command: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolveRun, reject) => {
        const child = spawn(command, args, {
            cwd,
            env: process.env,
            stdio: 'pipe',
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
        temporaryDirectories.splice(0).map((directory) =>
            rm(directory, { recursive: true, force: true })
        )
    );
});

describe('Recipe Console build boundary', () => {
    test('ships mutually exclusive Recipe Console and legacy experience chunks', async () => {
        await expect(access(assertionScript)).resolves.toBeUndefined();

        const outputRoot = await mkdtemp(join(tmpdir(), 'rallar-experience-build-'));
        temporaryDirectories.push(outputRoot);

        await run(
            join(repoRoot, 'node_modules/.bin/vite'),
            [
                'build',
                '--outDir',
                outputRoot,
                '--emptyOutDir',
            ],
            appRoot
        );
        await run(
            process.execPath,
            [
                assertionScript,
                outputRoot,
            ],
            repoRoot
        );

        const graph = readExperienceChunkGraph(
            join(outputRoot, '.vite/manifest.json'),
        );
        expect(graph.main).toBe('index.html');
        expect(graph.mainStaticClosure.size).toBeGreaterThan(1);
        expect(graph.mainDynamicEntries.size).toBeGreaterThan(2);
        expect([...graph.mainDynamicExperienceEntries]).toEqual([
            'src/recipe-console/app/RecipeConsoleApp.tsx',
            'src/legacy/shell/LegacyExperience.tsx',
        ]);
        expect(graph.recipeConsoleStaticClosure.size).toBeGreaterThan(1);
        expect(graph.legacyStaticClosure.size).toBeGreaterThan(1);
        expect([...graph.legacySafeDynamicEntries.keys()]).toEqual([
            'RunnerRecipesPanel',
            'RunnerRunsPanel',
            'RunnerFleetPanel',
            'FlowBuilderPanel',
            'DistributedRecipesPanel',
            'RunManagerPanel',
            'SharedTestPanel',
            'RoomsClientsPanel',
            'TopologyGraphPanel',
            'RtcDiagnosticsPanel',
        ]);
        expect(graph.legacyDynamicClosure.size).toBeGreaterThan(
            graph.legacyStaticClosure.size,
        );
        for (const entry of graph.legacySafeDynamicEntries.values()) {
            expect(graph.mainStaticClosure.has(entry)).toBe(false);
            expect(graph.legacyStaticClosure.has(entry)).toBe(false);
            expect(graph.recipeConsoleStaticClosure.has(entry)).toBe(false);
            expect(graph.legacyDynamicClosure.has(entry)).toBe(true);
            expect(graph.productionClosure.has(entry)).toBe(true);
        }
        expect(graph.retentionDynamicEntry).toBe(
            'src/recipe-console/control/control-retention-api.ts',
        );
        expect(graph.retentionStaticClosure.size).toBeGreaterThan(1);
        expect(graph.tuneStaticClosure.has(graph.retentionDynamicEntry)).toBe(false);
        expect(graph.recipeConsoleStaticClosure.has(graph.retentionDynamicEntry))
            .toBe(false);
        expect(graph.productionClosure.size).toBeGreaterThan(
            graph.mainStaticClosure.size,
        );
        expect([...graph.productionClosure].some(key =>
            key.includes('recipe-console-css-isolation')
        )).toBe(false);
        expect(() => assertExperienceChunkGraph(graph)).not.toThrow();

        const manifestPath = join(outputRoot, '.vite/manifest.json');
        const manifest = JSON.parse(
            await readFile(manifestPath, 'utf8'),
        ) as Record<string, {
            file: string;
            src?: string;
            imports?: string[];
            dynamicImports?: string[];
        }>;

        const legacyEntry = Object.entries(manifest).find(([, entry]) =>
            entry.src?.endsWith('/legacy/shell/LegacyExperience.tsx')
        );
        expect(legacyEntry).toBeDefined();
        for (const [label, safeEntry] of graph.legacySafeDynamicEntries) {
            const withStaticLeak = structuredClone(manifest);
            const legacyChunk = withStaticLeak[legacyEntry?.[0] ?? 'missing'];
            if (!legacyChunk) throw new Error('Legacy manifest entry is unavailable.');
            legacyChunk.imports = [...legacyChunk.imports ?? [], safeEntry];
            await writeFile(manifestPath, JSON.stringify(withStaticLeak));
            const staticLeakGraph = readExperienceChunkGraph(manifestPath);
            expect(
                () => assertExperienceChunkGraph(staticLeakGraph),
                `${label}: forced Legacy static import`,
            ).toThrow(new RegExp(
                `Legacy static closure includes safe legacy entry ${label}`,
            ));

            const withUnreachableEntry = structuredClone(manifest);
            for (const chunk of Object.values(withUnreachableEntry)) {
                chunk.imports = chunk.imports?.filter(entry => entry !== safeEntry);
                chunk.dynamicImports = chunk.dynamicImports?.filter(
                    entry => entry !== safeEntry,
                );
            }
            await writeFile(manifestPath, JSON.stringify(withUnreachableEntry));
            const unreachableGraph = readExperienceChunkGraph(manifestPath);
            expect(
                () => assertExperienceChunkGraph(unreachableGraph),
                `${label}: disconnected production entry`,
            ).toThrow(new RegExp(
                `Legacy safe dynamic entry ${label} is not production-reachable`,
            ));
        }
        await writeFile(manifestPath, JSON.stringify(manifest));

        const legacyJavaScriptChunks = await Promise.all(
            [...graph.legacyStaticClosure].map(async (key) => {
                const path = join(outputRoot, manifest[key]?.file ?? 'missing');
                return { path, text: await readFile(path, 'utf8') };
            }),
        );
        const statefulOwnerChunk = legacyJavaScriptChunks.find(({ text }) =>
            text.includes('quick-rallar-test-panel')
        );
        expect(statefulOwnerChunk).toBeDefined();
        await writeFile(
            statefulOwnerChunk?.path ?? 'missing',
            (statefulOwnerChunk?.text ?? '').replaceAll(
                'quick-rallar-test-panel',
                'missing-quick-owner',
            ),
        );
        const missingStatefulOwnerGraph = readExperienceChunkGraph(manifestPath);
        expect(() => assertExperienceChunkGraph(missingStatefulOwnerGraph))
            .toThrow(
                /Legacy static closure is missing the Quick Rallar Test stateful exception/,
            );
        await writeFile(
            statefulOwnerChunk?.path ?? 'missing',
            statefulOwnerChunk?.text ?? '',
        );

        const recipeChunk = Object.values(manifest).find(entry =>
            entry.src?.endsWith('/recipe-console/app/RecipeConsoleApp.tsx')
        );
        expect(recipeChunk).toBeDefined();
        const workerClientEntry = Object.entries(manifest).find(([, entry]) =>
            entry.src?.endsWith('/recipe-console/analyze/analyze-worker-client.ts')
        );
        const workerFactoryEntry = Object.entries(manifest).find(([, entry]) =>
            entry.src?.endsWith('/recipe-console/analyze/analyze-worker-factory.ts')
        );
        expect(workerClientEntry).toBeDefined();
        expect(workerFactoryEntry).toBeDefined();
        expect(graph.recipeConsoleStaticClosure.has(workerClientEntry?.[0] ?? 'missing'))
            .toBe(false);
        expect(graph.recipeConsoleStaticClosure.has(workerFactoryEntry?.[0] ?? 'missing'))
            .toBe(false);
        expect(await readdir(join(outputRoot, 'assets'))).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/^analyze-artifact\.worker-[^.]+\.js$/),
            ]),
        );
        const recipeChunkPath = join(outputRoot, recipeChunk?.file ?? 'missing');
        const recipeChunkText = await readFile(recipeChunkPath, 'utf8');
        expect(recipeChunkText).toContain('data-command-bar');
        await writeFile(
            recipeChunkPath,
            recipeChunkText.replaceAll('data-command-bar', 'corrupted-command-bar'),
        );
        const corruptedGraph = readExperienceChunkGraph(
            manifestPath,
        );
        expect(() => assertExperienceChunkGraph(corruptedGraph))
            .toThrow(/Recipe Console static closure sentinel is missing/);
        await writeFile(recipeChunkPath, recipeChunkText);

        const tuneChunk = Object.values(manifest).find(entry =>
            entry.src?.endsWith('/recipe-console/tune/TuneWorkspace.tsx')
        );
        expect(tuneChunk).toBeDefined();
        const tuneChunkPath = join(outputRoot, tuneChunk?.file ?? 'missing');
        const tuneChunkText = await readFile(tuneChunkPath, 'utf8');
        expect(tuneChunkText).toContain('data-history-workspace');
        await writeFile(
            tuneChunkPath,
            tuneChunkText.replaceAll(
                'data-history-workspace',
                'corrupted-history-workspace',
            ),
        );
        const corruptedTuneGraph = readExperienceChunkGraph(
            manifestPath,
        );
        expect(() => assertExperienceChunkGraph(corruptedTuneGraph))
            .toThrow(/Tune static closure History sentinels are missing/);
    });
});
