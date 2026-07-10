import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    appTabFromValue,
} from '../../../apps/rallar-black-box/src/app-tabs.ts';
import {
    normalizeAppNavigation,
} from '../../../apps/rallar-black-box/src/legacy/shell/navigation.ts';
import {
    ADVANCED_SURFACE_CATALOG,
} from '../../../apps/rallar-black-box/src/recipe-console/advanced/advanced-surface-catalog.ts';
import {
    createAdvancedLegacyHref,
} from '../../../apps/rallar-black-box/src/recipe-console/advanced/advanced-legacy-href.ts';
import type {
    RecipeConsoleUrlState,
} from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const legacyRoot = resolve(
    repositoryRoot,
    'apps/rallar-black-box/src/legacy',
);
const compatibilityOwners = [
    'shell/tabs/RunnerCompatibilityTabPanels.tsx',
    'shell/tabs/LegacyCompatibilityTailTabPanels.tsx',
] as const;
const ownerInventory = [
    {
        component: 'ManualRallarSection',
        owner: 'runner/advanced/RunnerAdvancedPanel.tsx',
    },
    {
        component: 'LocalWorkbenchSection',
        owner: 'runner/advanced/RunnerAdvancedPanel.tsx',
    },
    {
        component: 'RunManagerPanel',
        owner: 'runner/advanced/RunnerAdvancedPanel.tsx',
    },
    {
        component: 'DistributedRecipesPanel',
        owner: 'runner/advanced/RunnerAdvancedPanel.tsx',
    },
    {
        component: 'SharedTestPanel',
        owner: 'runner/advanced/RunnerAdvancedPanel.tsx',
    },
    {
        component: 'FlowBuilderPanel',
        owner: 'shell/tabs/RunnerWorkspaceTabPanels.tsx',
    },
] as const;
const sourceFiles = [
    'runner/advanced/RunnerAdvancedPanel.tsx',
    'shell/tabs/RunnerWorkspaceTabPanels.tsx',
    'shell/tabs/DirectConnectionTabPanels.tsx',
    ...compatibilityOwners,
] as const;
const recipeConsoleState: RecipeConsoleUrlState = {
    v: 1,
    experience: 'recipe-console',
    view: 'advanced',
};

describe('legacy route alias ownership', () => {
    it('normalizes every registered alias to its canonical visible owner and rollback route', () => {
        for (const surface of ADVANCED_SURFACE_CATALOG) {
            for (const alias of surface.aliases) {
                const navigation = normalizeAppNavigation({
                    mode: surface.route.workspace,
                    tab: appTabFromValue(alias),
                });
                const href = createAdvancedLegacyHref({
                    surface: alias,
                    state: recipeConsoleState,
                });
                const url = new URL(href ?? '', 'https://console.test');

                expect.soft(navigation.mode, `${alias}: canonical mode`).toBe(
                    surface.route.workspace,
                );
                expect.soft(navigation.tab, `${alias}: visible tab`).toBe(
                    surface.route.tab,
                );
                expect.soft(
                    navigation.advancedSurface,
                    `${alias}: Advanced child`,
                ).toBe(surface.route.advancedSurface);
                expect.soft(url.searchParams.get('experience'), `${alias}: legacy experience`)
                    .toBe('legacy');
                expect.soft(url.searchParams.get('workspace'), `${alias}: rollback workspace`)
                    .toBe(surface.route.workspace);
                expect.soft(url.searchParams.get('tab'), `${alias}: rollback tab`)
                    .toBe(surface.route.tab);
                expect.soft(
                    url.searchParams.get('advancedSurface') ?? undefined,
                    `${alias}: rollback Advanced child`,
                ).toBe(surface.route.advancedSurface);
                expect.soft(url.searchParams.get('legacySurface'), `${alias}: stable leaf`)
                    .toBe(surface.id);
            }
        }
    });

    it('keeps exactly one real owner for every previously duplicated workflow', () => {
        const sources = sourceFiles
            .filter(path => existsSync(resolve(legacyRoot, path)))
            .map(path => ({
                path,
                source: readFileSync(resolve(legacyRoot, path), 'utf8'),
            }));

        for (const { component, owner } of ownerInventory) {
            const calls = sources.flatMap(({ path, source }) =>
                [...source.matchAll(new RegExp(`<${component}\\b`, 'g'))]
                    .map(() => path)
            );
            expect.soft(calls, component).toEqual([owner]);
        }
        for (const path of compatibilityOwners) {
            expect.soft(existsSync(resolve(legacyRoot, path)), path).toBe(false);
        }
    });
});
