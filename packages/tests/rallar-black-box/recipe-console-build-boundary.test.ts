import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

        const manifest = JSON.parse(
            await readFile(join(outputRoot, '.vite/manifest.json'), 'utf8'),
        ) as Record<string, { file: string; src?: string }>;
        const recipeChunk = Object.values(manifest).find(entry =>
            entry.src?.endsWith('/recipe-console/app/RecipeConsoleApp.tsx')
        );
        expect(recipeChunk).toBeDefined();
        const recipeChunkPath = join(outputRoot, recipeChunk?.file ?? 'missing');
        const recipeChunkText = await readFile(recipeChunkPath, 'utf8');
        expect(recipeChunkText).toContain('data-command-bar');
        await writeFile(
            recipeChunkPath,
            recipeChunkText.replaceAll('data-command-bar', 'corrupted-command-bar'),
        );
        const corruptedGraph = readExperienceChunkGraph(
            join(outputRoot, '.vite/manifest.json'),
        );
        expect(() => assertExperienceChunkGraph(corruptedGraph))
            .toThrow(/Recipe Console static closure sentinel is missing/);
    });
});
