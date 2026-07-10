import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const appSourcePath = 'apps/rallar-black-box/src/App.tsx';
const recipeConsoleSourcePath = 'apps/rallar-black-box/src/recipe-console';
const extractedModulePaths = [
    'apps/rallar-black-box/src/legacy/shell/browser-ui-storage.ts',
    'apps/rallar-black-box/src/legacy/shell/navigation.ts',
    'apps/rallar-black-box/src/legacy/shell/global-context-model.ts',
    'apps/rallar-black-box/src/legacy/runner/runner-contracts.ts',
    'apps/rallar-black-box/src/legacy/rallar/load-browser-rallar-facade.ts',
] as const;
const extractedModuleImports = [
    './legacy/shell/browser-ui-storage.ts',
    './legacy/shell/navigation.ts',
    './legacy/shell/global-context-model.ts',
    './legacy/runner/runner-contracts.ts',
    './legacy/rallar/load-browser-rallar-facade.ts',
] as const;

function repositorySource(path: string): string {
    return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

function sourceFilesUnder(path: string): readonly string[] {
    const absolutePath = resolve(repositoryRoot, path);
    if (!existsSync(absolutePath)) {
        return [];
    }

    return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = join(absolutePath, entry.name);
        if (entry.isDirectory()) {
            return sourceFilesUnder(relative(repositoryRoot, entryPath));
        }
        return ['.ts', '.tsx'].includes(extname(entry.name))
            ? [relative(repositoryRoot, entryPath)]
            : [];
    });
}

describe('rallar-black-box app source ownership', () => {
    it('documents the Recipe Console and legacy extraction ownership boundary', () => {
        const source = repositorySource(appSourcePath).replace(/\s+/g, ' ');

        expect(source).toContain(
            'Recipe Console work belongs under `src/recipe-console/**`; legacy extraction belongs under `src/legacy/**`; no new feature panel belongs in `App.tsx`.',
        );
    });

    it('keeps extracted legacy contracts in their focused modules', () => {
        for (const modulePath of extractedModulePaths) {
            expect(existsSync(resolve(repositoryRoot, modulePath)), modulePath).toBe(true);
        }
    });

    it('imports every extracted legacy contract directly from App.tsx', () => {
        const source = repositorySource(appSourcePath);

        for (const moduleImport of extractedModuleImports) {
            expect(source, moduleImport).toContain(`from '${moduleImport}';`);
        }
    });

    it('does not duplicate extracted legacy declarations in App.tsx', () => {
        const source = repositorySource(appSourcePath);
        const extractedDeclarations = [
            /^\s*type\s+AppNavigationState\s*=/m,
            /\bfunction\s+advancedSurfaceFromValue\b/,
            /\bfunction\s+normalizeAppNavigation\b/,
            /\bfunction\s+readInitialAppNavigation\b/,
            /\bfunction\s+writeAppNavigationToUrl\b/,
            /\bfunction\s+browserUiStorage\b/,
            /^\s*type\s+CommandCenterGlobalValues\s*=/m,
            /^\s*type\s+CommandQueueRow\s*=/m,
            /^\s*type\s+RunnerDistributedRunSelection\s*=/m,
            /\basync\s+function\s+loadBrowserRallarFacade\b/,
        ];

        for (const declaration of extractedDeclarations) {
            expect(source, declaration.source).not.toMatch(declaration);
        }
    });

    it('does not declare Recipe Console panels in App.tsx', () => {
        const source = repositorySource(appSourcePath);

        expect(source).not.toMatch(/\bRecipeConsole\w*Panel\b/);
        expect(source).not.toMatch(/\bfunction\s+RecipeConsole\w*/);
    });

    it('keeps future Recipe Console features behind the legacy compatibility router', () => {
        const forbiddenImports = sourceFilesUnder(recipeConsoleSourcePath).flatMap((sourcePath) => {
            const source = repositorySource(sourcePath);
            const imports = source.matchAll(
                /(?:\bfrom\s+|\bimport\s*\(\s*)['"]([^'"]*legacy\/[^'"]*)['"]/g,
            );

            return [...imports]
                .map((match) => match[1])
                .filter((moduleImport) => !moduleImport.includes('LegacySurfaceRouter'))
                .map((moduleImport) => `${sourcePath}: ${moduleImport}`);
        });

        expect(forbiddenImports).toEqual([]);
    });
});
