import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const appPath = 'apps/rallar-black-box/src/App.tsx';
const legacyExperiencePath =
    'apps/rallar-black-box/src/legacy/shell/LegacyExperience.tsx';
const recipeConsolePath =
    'apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx';

function source(path: string): string {
    return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

describe('Recipe Console experience boundary', () => {
    test('keeps App as a two-way lazy experience router after auth gates', () => {
        const app = source(appPath);
        const dynamicExperienceImports = [...app.matchAll(
            /lazy\(\(\)\s*=>\s*import\(['"]([^'"]+)['"]\)\s*\)/g,
        )].map(match => match[1]);

        expect(dynamicExperienceImports).toEqual([
            './recipe-console/app/RecipeConsoleApp.tsx',
            './legacy/shell/LegacyExperience.tsx',
        ]);
        expect(app).toContain(
            "import { useExperienceRoute } from './app/use-experience-route.ts';",
        );
        expect(app).not.toMatch(/\btype\s+AppExperience\b/);
        expect(app).not.toMatch(/\bfunction\s+experienceFromSearch\b/);
        expect(app).not.toContain("addEventListener('popstate'");
        expect(app).not.toMatch(/from ['"].*LegacyAppShell\.tsx['"]/);
        expect(app).not.toMatch(
            /\b(?:useRunnerShellState|useLegacyNavigation|useCommandCenterGlobalContext|useRunnerShellSelectionSync|ensureBootstrapped)\b/,
        );
        expect(app).not.toMatch(/\b(?:RecipeConsole|Legacy)\w*(?:Panel|Section)\b/);
        expect(app.match(/<Suspense\b/g)).toHaveLength(1);
        expect(app.match(/\?\s*<RecipeConsoleApp\b[\s\S]*:\s*<LegacyExperience\b/g))
            .toHaveLength(1);
        expect(app.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(260);
    });

    test('makes LegacyExperience the sole legacy controller owner', () => {
        expect(existsSync(resolve(repositoryRoot, legacyExperiencePath))).toBe(true);
        const legacyExperience = source(legacyExperiencePath);
        const app = source(appPath);
        expect(legacyExperience.trimEnd().split(/\r?\n/).length)
            .toBeLessThanOrEqual(100);

        for (const controller of [
            'useRunnerShellState',
            'useLegacyNavigation',
            'useCommandCenterGlobalContext',
            'ensureBootstrapped',
            'useRunnerShellSelectionSync',
        ]) {
            expect(legacyExperience, `${controller} owned by lazy legacy wrapper`)
                .toContain(controller);
            expect(app, `${controller} absent from App`).not.toContain(controller);
        }
        expect(legacyExperience).toContain("import '../../styles.css';");
        expect(legacyExperience).toContain('<LegacyAppShell');
    });

    test('keeps Recipe Console independent of legacy modules and bounded', () => {
        expect(existsSync(resolve(repositoryRoot, recipeConsolePath))).toBe(true);
        const recipeConsole = source(recipeConsolePath);
        expect(recipeConsole).toContain('className="recipe-console"');
        expect(recipeConsole).toContain('data-view="execute"');
        expect(recipeConsole).not.toMatch(/(?:from\s+|import\()['"][^'"]*legacy\/[^'"]*['"]/);
        expect(recipeConsole.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(180);
    });

    test('loads only auth CSS statically while preserving legacy CSS bytes', () => {
        const authCss = source('apps/rallar-black-box/src/auth.css');
        expect(source('apps/rallar-black-box/src/main.tsx')).toContain("import './auth.css';");
        expect(source('apps/rallar-black-box/src/main.tsx')).not.toContain("import './styles.css';");
        expect(authCss).toMatch(
            /\.auth-panel \.pill\.active\s*\{\s*color:\s*#0c6f7b;\s*\}/,
        );
        expect(authCss).not.toMatch(/^\.active\s*\{/m);
        expect(createHash('sha256')
            .update(source('apps/rallar-black-box/src/styles.css'))
            .digest('hex'))
            .toBe('9778cfa43e7a858b30a9304b36b2939bfbf89df2722ac05a65b97579a37640b4');
    });

    test('restricts the Vite-only browser project to Recipe Console specs', () => {
        const config = source(
            'apps/rallar-black-box/playwright.recipe-console.config.ts',
        );
        expect(config).toContain('testMatch: /recipe-console-.*\\.spec\\.ts/');
        expect(config).toContain("baseURL: 'http://127.0.0.1:5176'");
        expect(config.match(/webServer:/g)).toHaveLength(1);
        expect(config).not.toMatch(/control-server|RALLAR_BLACK_BOX_CONTROL/i);
    });

    test('includes emitted CSS in the executable experience closure proof', () => {
        const assertion = source(
            'apps/rallar-black-box/scripts/assert-experience-chunks.ts',
        );
        expect(assertion).toContain('css?: readonly string[];');
        expect(assertion).toContain('...(chunk.css ?? [])');
    });
});
