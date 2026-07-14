import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const recipeRoot = 'apps/rallar-black-box/src/recipe-console';
const historyRoot = `${recipeRoot}/history`;
const historyWorkspace = `${historyRoot}/HistoryWorkspace.tsx`;
const historyHeader = `${historyRoot}/HistoryHeader.tsx`;
const historyRetentionWorkspace = `${historyRoot}/HistoryRetentionWorkspace.tsx`;
const retentionCleanup = `${historyRoot}/use-retention-cleanup.ts`;
const retentionCleanupModel = `${historyRoot}/retention-cleanup-model.ts`;
const retentionPanel = `${historyRoot}/RetentionPanel.tsx`;
const retentionDialog = `${historyRoot}/RetentionConfirmDialog.tsx`;
const retentionConsequences = `${historyRoot}/RetentionConsequenceViews.tsx`;
const retentionCandidate = `${historyRoot}/RetentionCandidateRow.tsx`;
const retentionDisclosure = `${historyRoot}/RetentionDisclosure.tsx`;
const retentionWindow = `${historyRoot}/RetentionWindowedList.tsx`;
const tuneWorkspace = `${recipeRoot}/tune/TuneWorkspace.tsx`;
const workspace = `${recipeRoot}/app/RecipeConsoleWorkspace.tsx`;
const activeWork = `${recipeRoot}/app/RecipeConsoleActiveWork.tsx`;
const historyModel = `${historyRoot}/history-model.ts`;
const historyCollection = `${historyRoot}/history-window-collection.ts`;
const historyWindowModel = `${historyRoot}/history-window-model.ts`;
const historyWindowHook = `${historyRoot}/use-history-window.ts`;
const historyWindowTruth = `${historyRoot}/HistoryWindowTruth.tsx`;
const historyTable = `${historyRoot}/HistoryTable.tsx`;

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

    test('delegates History heading and provenance presentation to one focused owner', () => {
        expect(existsSync(resolve(root, historyHeader))).toBe(true);
        const history = source(historyWorkspace);
        expect(importedSpecifiers(history).filter(specifier =>
            specifier === './HistoryHeader.tsx'
        )).toEqual(['./HistoryHeader.tsx']);
        expect(history.match(/<HistoryHeader\b/g)).toHaveLength(1);
        expect(history).not.toMatch(
            /function (?:provenanceLabel|provenanceTone|historyNotice|filterSummary)\b/,
        );
    });

    test('owns one focused 80-row History window without a replacement monolith', () => {
        for (const [path, budget] of [
            [historyModel, 80],
            [historyCollection, 220],
            [historyWindowModel, 220],
            [historyWindowHook, 60],
            [historyWindowTruth, 70],
            [historyWorkspace, 180],
            [historyTable, 270],
            [`${historyRoot}/HistoryTable.module.css`, 290],
        ] as const) {
            expect(existsSync(resolve(root, path)), path).toBe(true);
            expect(lines(path), path).toBeLessThanOrEqual(budget);
        }

        const facade = source(historyModel);
        const collection = source(historyCollection);
        const projection = source(historyWindowModel);
        const history = source(historyWorkspace);
        const table = source(historyTable);
        expect(facade).toContain('deriveRecipeConsoleHistoryModel');
        expect(facade).toContain('RECIPE_CONSOLE_HISTORY_ROW_LIMIT');
        expect(projection).toContain('RECIPE_CONSOLE_HISTORY_WINDOW_SIZE = 80');
        expect(collection).not.toMatch(
            /buildTuneRunCatalog|projectDistributedRunHistoryLabels|\.agents\b|historyRowSelectionActions/,
        );
        expect(projection).toMatch(
            /buildTuneRunCatalog[\s\S]*projectDistributedRunHistoryLabels[\s\S]*historyRowSelectionActions/,
        );
        expect(history).toMatch(
            /createRecipeConsoleHistoryCollection[\s\S]*useHistoryWindow[\s\S]*deriveRecipeConsoleHistoryWindow/,
        );
        expect(table.match(/<ExplicitWindowControls\b/g)).toHaveLength(1);
        expect(table.indexOf('data-history-window-controls')).toBeLessThan(
            table.indexOf('className={styles.scrollRegion}'),
        );
        expect(table).not.toMatch(/<select\b|\.slice\(\s*0\s*,\s*(?:80|100)\s*\)/);
        expect(`${collection}\n${projection}\n${history}\n${table}`).not.toMatch(
            /registry|Registry|\/legacy\//,
        );
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
        for (const path of owners.filter(path => /\.(?:ts|tsx|css)$/.test(path))) {
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

    test('owns one lazy token-free retention workflow below History', () => {
        for (const path of [
            historyRetentionWorkspace,
            retentionCleanup,
            retentionCleanupModel,
            retentionPanel,
            retentionDialog,
            retentionConsequences,
            retentionCandidate,
            retentionDisclosure,
            retentionWindow,
        ]) expect(existsSync(resolve(root, path)), path).toBe(true);

        const history = source(historyWorkspace);
        const owner = source(historyRetentionWorkspace);
        const hook = source(retentionCleanup);
        const production = filesBelow(historyRoot)
            .filter(path => /\.(?:ts|tsx)$/.test(path))
            .map(source)
            .join('\n');
        const retentionOwners = [
            historyRetentionWorkspace,
            retentionCleanup,
            retentionCleanupModel,
            retentionPanel,
            retentionDialog,
            retentionConsequences,
            retentionCandidate,
            retentionDisclosure,
            retentionWindow,
        ].map(source).join('\n');
        const rootOwners = `${source(workspace)}\n${source(activeWork)}`;

        expect(importedSpecifiers(history).filter(specifier =>
            specifier === './HistoryRetentionWorkspace.tsx'
        )).toEqual(['./HistoryRetentionWorkspace.tsx']);
        expect(history.match(/<HistoryRetentionWorkspace\b/g)).toHaveLength(1);
        expect(rootOwners).not.toMatch(
            /HistoryRetentionWorkspace|RetentionPanel|RetentionConfirmDialog|useRetentionCleanup/,
        );
        expect(hook).toMatch(/await capability\.load\(\)/);
        expect(hook).toMatch(
            /useLayoutEffect\(\(\) => \{\s*const context = \+\+contextRef\.current;/,
        );
        const controlRetentionImports = [...hook.matchAll(
            /import\s+(?:type\s+)?(?:\{[^}]*\}|[^;]*?)\s+from\s+['"][^'"]*control-retention[^'"]*['"];/g,
        )].map(match => match[0]);
        expect(controlRetentionImports).toHaveLength(2);
        expect(controlRetentionImports.every(value => /^import\s+type\b/.test(value)))
            .toBe(true);
        expect(production).not.toMatch(/\bplanToken\b|\bfetch\s*\(/);
        expect(retentionOwners).not.toMatch(
            /localStorage|sessionStorage|indexedDB|document\.cookie|console\./,
        );

        const refresh = owner.indexOf('await refreshAfterCurrent()');
        const selectionPatch = owner.indexOf(
            'retentionSelectionPatchAfterCleanup',
            refresh,
        );
        const replaceSelection = owner.indexOf('replace(patch)', refresh);
        expect(refresh).toBeGreaterThan(-1);
        expect(selectionPatch).toBeGreaterThan(refresh);
        expect(replaceSelection).toBeGreaterThan(selectionPatch);
    });

    test('bounds every retention consequence without a replacement monolith', () => {
        for (const [path, budget] of [
            [retentionPanel, 140],
            [retentionDialog, 190],
            [retentionConsequences, 150],
            [retentionCandidate, 110],
            [retentionDisclosure, 110],
            [retentionWindow, 140],
            [`${historyRoot}/RetentionWindowedList.module.css`, 60],
        ] as const) {
            expect(lines(path), path).toBeLessThanOrEqual(budget);
        }

        const consequences = source(retentionConsequences);
        const window = source(retentionWindow);
        expect(window).toContain('RECIPE_CONSOLE_RETENTION_SURFACE_ROW_BUDGET = 100');
        expect(window).toMatch(
            /RECIPE_CONSOLE_RETENTION_WINDOW_SIZE\s*=\s*\n?\s*RECIPE_CONSOLE_RETENTION_SURFACE_ROW_BUDGET \/ 2/,
        );
        expect(window).toMatch(/useExplicitWindow[\s\S]*ExplicitWindowControls/);
        expect(window).not.toMatch(/\.slice\(\s*0\s*,\s*100\s*\)/);
        expect(consequences).toMatch(
            /RetentionPreviewEvidence[\s\S]*<RetentionWindowedList/,
        );
        expect(consequences).toMatch(
            /RetentionCleanupResult[\s\S]*Deleted control run IDs/,
        );
        expect(`${consequences}\n${window}`).not.toMatch(
            /\bplanToken\b|registry|Registry|\/legacy\//,
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
