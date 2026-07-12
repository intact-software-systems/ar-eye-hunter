import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const recipeRoot = 'apps/rallar-black-box/src/recipe-console';
const historyRoot = `${recipeRoot}/history`;
const historyWorkspace = `${historyRoot}/HistoryWorkspace.tsx`;
const tuneWorkspace = `${recipeRoot}/tune/TuneWorkspace.tsx`;
const workspace = `${recipeRoot}/app/RecipeConsoleWorkspace.tsx`;
const activeWork = `${recipeRoot}/app/RecipeConsoleActiveWork.tsx`;

function source(path: string): string {
    return readFileSync(resolve(root, path), 'utf8');
}

function lines(path: string): number {
    return source(path).trimEnd().split(/\r?\n/).length;
}

function filesBelow(path: string): string[] {
    return readdirSync(resolve(root, path), {
        recursive: true,
        encoding: 'utf8',
    }).map(entry => `${path}/${entry}`);
}

function importedSpecifiers(file: string): string[] {
    return [...file.matchAll(
        /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g,
    )].map(match => match[1] ?? match[2] ?? match[3]);
}

describe('Recipe Console History composition boundary', () => {
    test('composes exactly one bounded History workspace after Tune evidence', () => {
        expect(existsSync(resolve(root, historyWorkspace))).toBe(true);
        const tune = source(tuneWorkspace);
        const rootWorkspace = source(workspace);
        const active = source(activeWork);

        expect(importedSpecifiers(tune).filter(specifier =>
            specifier === '../history/HistoryWorkspace.tsx'
        )).toEqual(['../history/HistoryWorkspace.tsx']);
        expect(tune.match(/<HistoryWorkspace\b/g)).toHaveLength(1);
        expect(tune.indexOf('<TuneComparison')).toBeLessThan(
            tune.indexOf('<HistoryWorkspace'),
        );
        expect(rootWorkspace).not.toMatch(/HistoryWorkspace|\/history\//);
        expect(active).not.toMatch(/HistoryWorkspace|\/history\//);
        expect(active.match(/<TuneWorkspace\b/g)).toHaveLength(1);
    });

    test('keeps History owners focused, read-only, and locally styled', () => {
        const owners = filesBelow(historyRoot)
            .filter(path => /\.(?:ts|tsx|css)$/.test(path))
            .sort();
        const ownerSources = owners
            .filter(path => /\.tsx?$/.test(path))
            .map(path => [path, source(path)] as const);

        expect(lines(historyWorkspace)).toBeLessThanOrEqual(180);
        expect(lines(tuneWorkspace)).toBeLessThanOrEqual(180);
        for (const path of owners.filter(path => /\.(?:tsx|css)$/.test(path))) {
            expect(lines(path), path).toBeLessThanOrEqual(300);
        }

        const imports = ownerSources.flatMap(([path, file]) =>
            importedSpecifiers(file).map(specifier => `${path}: ${specifier}`)
        );
        expect(imports.filter(value => /\/legacy\//.test(value))).toEqual([]);
        expect(imports.filter(value =>
            /control-execution|ControlCommandContext|use-control-workspace/.test(value)
        )).toEqual([]);
        const all = ownerSources.map(([, file]) => file).join('\n');
        expect(all).not.toMatch(/\bfetch\s*\(|compareDistributedRuns|retainedArtifact/);

        const css = owners.filter(path => path.endsWith('.css'));
        expect(css.length).toBeGreaterThan(0);
        expect(css.every(path => path.endsWith('.module.css'))).toBe(true);
        expect(source('apps/rallar-black-box/src/styles.css'))
            .not.toMatch(
                /\[data-history-(?:workspace|filters|saved-filters|row-key)/,
            );
    });

    test('keeps History state out of the root workspace and retention lazy', () => {
        const rootWorkspace = source(workspace);
        const active = source(activeWork);
        const eager = `${rootWorkspace}\n${active}`;

        expect(rootWorkspace).not.toMatch(
            /useHistoryFilterPresets|deriveRecipeConsoleHistoryModel|historyQuery.*useState/,
        );
        expect(eager).not.toMatch(
            /control-retention-(?:api|request|validation)|planToken/,
        );
    });

    test('keeps History reachable in short landscape with contained table overflow', () => {
        const tuneCss = source(`${recipeRoot}/tune/TuneWorkspace.module.css`);
        const tableCss = source(`${historyRoot}/HistoryTable.module.css`);
        const shortLandscape = tuneCss.match(
            /@media \(max-height: 520px\)[\s\S]*$/,
        )?.[0] ?? '';

        expect(shortLandscape).toMatch(
            /\.workspace\s*\{[\s\S]*height:\s*100%;[\s\S]*min-height:\s*0;[\s\S]*overflow-y:\s*auto;/,
        );
        expect(shortLandscape).toContain('overscroll-behavior: contain');
        expect(tableCss).toMatch(
            /\.scrollRegion\s*\{[\s\S]*overflow:\s*auto;[\s\S]*overscroll-behavior:\s*contain;/,
        );
        expect(tableCss).toMatch(/\.table\s*\{[\s\S]*min-width:\s*\d+px;/);
    });
});
