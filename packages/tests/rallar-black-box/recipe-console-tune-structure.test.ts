import {
    existsSync,
    readFileSync,
    readdirSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const recipeConsoleRoot = 'apps/rallar-black-box/src/recipe-console';
const workspacePath = `${recipeConsoleRoot}/app/RecipeConsoleWorkspace.tsx`;
const activeWorkPath = `${recipeConsoleRoot}/app/RecipeConsoleActiveWork.tsx`;
const tuneRoot = `${recipeConsoleRoot}/tune`;
const tuneWorkspacePath = `${tuneRoot}/TuneWorkspace.tsx`;
const tuneInspectionHostPath = `${tuneRoot}/use-tune-inspection-host.tsx`;

function source(path: string): string {
    return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

function filesBelow(path: string): string[] {
    return readdirSync(resolve(repositoryRoot, path), {
        recursive: true,
        encoding: 'utf8',
    }).map(entry => `${path}/${entry}`);
}

function lines(path: string): number {
    return source(path).trimEnd().split(/\r?\n/).length;
}

function importedSpecifiers(file: string): string[] {
    return [
        ...file.matchAll(
            /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g,
        ),
    ].map(match => match[1] ?? match[2] ?? match[3]);
}

function tuneOwners(): string[] {
    return filesBelow(tuneRoot)
        .filter(path => /\.(?:ts|tsx|css)$/.test(path))
        .sort();
}

describe('Recipe Console Tune composition boundary', () => {
    test('mounts exactly one TuneWorkspace behind a local lazy route boundary', () => {
        const activeWork = source(activeWorkPath);
        const workspace = source(workspacePath);
        const tuneBranch = activeWork.match(
            /case ['"]tune['"]:([\s\S]*?)case ['"]fleet['"]:/,
        )?.[1] ?? '';

        expect(existsSync(resolve(repositoryRoot, tuneWorkspacePath))).toBe(true);
        expect(importedSpecifiers(activeWork).filter(
            specifier => specifier === '../tune/TuneWorkspace.tsx',
        )).toEqual(['../tune/TuneWorkspace.tsx']);
        expect(activeWork).toMatch(
            /import\s*\{(?=[^}]*\blazy\b)(?=[^}]*\bSuspense\b)[^}]*\}\s*from\s*['"]react['"]/,
        );
        expect(activeWork.match(
            /\blazy\s*\(\s*\(\)\s*=>\s*import\(\s*['"]\.\.\/tune\/TuneWorkspace\.tsx['"]\s*\)\s*\)/g,
        )).toHaveLength(1);
        expect(activeWork.match(/<Suspense\b/g)).toHaveLength(1);
        expect(activeWork.match(/<TuneWorkspace\b/g)).toHaveLength(1);
        expect(tuneBranch).toMatch(/<Suspense\b[\s\S]*<TuneWorkspace\b[\s\S]*<\/Suspense>/);
        expect(tuneBranch).not.toMatch(/\bhidden\b|display\s*:\s*none/);
        expect(workspace).not.toMatch(/TuneWorkspace|(?:from\s+|import\()['"][^'"]*\/tune\//);
    });

    test('removes preview and seeded Tune ownership from Recipe Console', () => {
        const removed = [
            `${tuneRoot}/TunePreview.tsx`,
            `${tuneRoot}/TimingDistribution.tsx`,
            `${tuneRoot}/TunePreview.module.css`,
            `${recipeConsoleRoot}/data/recipe-console-models.ts`,
            `${recipeConsoleRoot}/data/seeded-console-state.ts`,
        ];
        for (const path of removed) {
            expect(existsSync(resolve(repositoryRoot, path)), path).toBe(false);
        }

        const recipeSources = filesBelow(recipeConsoleRoot)
            .filter(path => /\.tsx?$/.test(path))
            .map(source)
            .join('\n');
        expect(recipeSources).not.toMatch(
            /TunePreview|TimingDistribution|TunePreviewModel|TunePoint|RecipeConsoleSeedState|createRecipeConsoleSeedState|seeded-console-state|recipe-console-models|\bseedState\b|\bseededRevision\b/,
        );

        const workspace = source(workspacePath);
        expect(workspace).not.toMatch(
            /\b(?:tuneAgentId|setTuneAgentId|inspectTuneAgent|onInspectTuneAgent)\b/,
        );
        expect(workspace).not.toMatch(
            /const\s*\[\s*\w*(?:tune|seed)\w*\s*,[^\]]*\]\s*=\s*useState/iu,
        );
    });

    test('keeps scoped inspection synchronization in a focused Tune owner', () => {
        const workspace = source(tuneWorkspacePath);

        expect(existsSync(resolve(repositoryRoot, tuneInspectionHostPath)))
            .toBe(true);
        expect(importedSpecifiers(workspace).filter(
            specifier => specifier === './use-tune-inspection-host.tsx',
        )).toEqual(['./use-tune-inspection-host.tsx']);
        expect(workspace).toMatch(
            /\bconst\s+inspect\s*=\s*useTuneInspectionHost\s*\(\s*\{/,
        );
        expect(workspace).not.toMatch(
            /\b(?:TuneInspector|tuneInspectionAuthority|tuneInspectionLabel|scopedInspection|setScopedInspection|useLayoutEffect|useState)\b/,
        );

        const inspectionHost = source(tuneInspectionHostPath);
        expect(inspectionHost).toMatch(/\bexport function useTuneInspectionHost\b/);
        expect(inspectionHost).toMatch(/<TuneInspector\b/);
        expect(inspectionHost).toMatch(/\btuneInspectionAuthority\s*\(/);
        expect(inspectionHost).toMatch(/\btuneInspectionLabel\s*\(/);
        expect(inspectionHost).toMatch(/\bonInspect\s*\(\s*trigger\s*\)/);
        expect(inspectionHost).toMatch(/\buseLayoutEffect\s*\(/);
        expect(inspectionHost).toMatch(
            /onInspectorChange\s*\(\s*undefined\s*\)[\s\S]*onSelectionLabelChange\s*\(\s*undefined\s*\)/,
        );
    });

    test('keeps root composition and every Tune owner within structure caps', () => {
        expect(lines(workspacePath), workspacePath).toBeLessThanOrEqual(220);
        expect(lines(activeWorkPath), activeWorkPath).toBeLessThanOrEqual(100);
        expect(existsSync(resolve(repositoryRoot, tuneWorkspacePath))).toBe(true);

        const owners = tuneOwners();
        expect(owners).toContain(tuneWorkspacePath);
        for (const path of owners) {
            expect(lines(path), path).toBeLessThanOrEqual(300);
        }
        if (existsSync(resolve(repositoryRoot, tuneWorkspacePath))) {
            expect(lines(tuneWorkspacePath), tuneWorkspacePath)
                .toBeLessThanOrEqual(180);
        }
    });

    test('keeps Tune read-only and its CSS Modules co-located', () => {
        const owners = tuneOwners();
        const ownerSources = owners
            .filter(path => /\.tsx?$/.test(path))
            .map(path => [path, source(path)] as const);
        const forbiddenImports = ownerSources.flatMap(([path, file]) =>
            importedSpecifiers(file)
                .filter(specifier => /(?:control-api|control-execution-api|control-authorized-transport|use-control-workspace|ControlConnectionProvider|ControlCommandContext|control-run-manager)/.test(specifier))
                .map(specifier => `${path}: ${specifier}`)
        );
        expect(forbiddenImports).toEqual([]);
        expect(ownerSources.map(([, file]) => file).join('\n'))
            .not.toMatch(/\bfetch\s*\(/);

        const cssOwners = owners.filter(path => path.endsWith('.css'));
        expect(cssOwners.length).toBeGreaterThan(0);
        expect(cssOwners.every(path => path.endsWith('.module.css'))).toBe(true);

        const cssImports = ownerSources.flatMap(([path, file]) =>
            importedSpecifiers(file)
                .filter(specifier => specifier.endsWith('.css'))
                .map(specifier => ({ path, specifier }))
        );
        expect(cssImports.length).toBeGreaterThan(0);
        for (const { path, specifier } of cssImports) {
            expect(specifier, path).toMatch(/^\.\/.+\.module\.css$/);
            expect(resolve(repositoryRoot, dirname(path), specifier).startsWith(
                resolve(repositoryRoot, tuneRoot),
            ), `${path}: ${specifier}`).toBe(true);
        }
        for (const path of cssOwners) {
            expect(cssImports.some(({ path: importer, specifier }) =>
                resolve(repositoryRoot, dirname(importer), specifier) ===
                    resolve(repositoryRoot, path)
            ), path).toBe(true);
        }

        const globalStyles = [
            'apps/rallar-black-box/src/styles.css',
            ...filesBelow(recipeConsoleRoot)
                .filter(path => path.endsWith('.css') &&
                    !path.endsWith('.module.css')),
        ];
        for (const path of globalStyles) {
            expect(source(path), path)
                .not.toMatch(/\[data-tune|\.tune(?:[-_A-Z]|\b)/);
        }
    });
});
