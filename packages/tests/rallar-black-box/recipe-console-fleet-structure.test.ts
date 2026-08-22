import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const recipeConsoleRoot = 'apps/rallar-black-box/src/recipe-console';
const fleetRoot = `${recipeConsoleRoot}/fleet`;
const workspacePath = `${recipeConsoleRoot}/app/RecipeConsoleWorkspace.tsx`;
const activeWorkPath = `${recipeConsoleRoot}/app/RecipeConsoleActiveWork.tsx`;
const fleetWorkspacePath = `${fleetRoot}/FleetWorkspace.tsx`;
const fleetContractPath = `${fleetRoot}/fleet-workspace-contract.ts`;
const focusAnchorPath = `${recipeConsoleRoot}/ui/owning-window-focus-anchor.ts`;

function source(path: string): string {
    return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

function filesBelow(path: string): string[] {
    return readdirSync(resolve(repositoryRoot, path), {
        recursive: true,
        encoding: 'utf8'
    }).map((entry) => `${path}/${entry}`);
}

function lines(path: string): number {
    return source(path).trimEnd().split(/\r?\n/).length;
}

function importedSpecifiers(file: string): string[] {
    return [
        ...file.matchAll(
            /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g
        )
    ].map((match) => match[1] ?? match[2] ?? match[3]);
}

describe('Recipe Console Fleet composition boundary', () => {
    test('mounts Fleet only behind its active lazy route and local Suspense', () => {
        const activeWork = source(activeWorkPath);
        const workspace = source(workspacePath);
        const fleetBranch = activeWork.match(
            /case ['"]fleet['"]:([\s\S]*?)case ['"]advanced['"]:/
        )?.[1] ?? '';

        expect(existsSync(resolve(repositoryRoot, fleetWorkspacePath))).toBe(true);
        expect(existsSync(resolve(repositoryRoot, fleetContractPath))).toBe(true);
        expect(activeWork).toContain(
            'const FleetWorkspace = lazy(() => import(\'../fleet/FleetWorkspace.tsx\'));'
        );
        expect(activeWork).not.toMatch(
            /import\s*\{[^}]*\bFleetWorkspace\b[^}]*\}\s*from/
        );
        expect(fleetBranch.match(/<Suspense\b/g)).toHaveLength(1);
        expect(fleetBranch.match(/<FleetWorkspace\b/g)).toHaveLength(1);
        expect(fleetBranch).toMatch(
            /<Suspense\b[\s\S]*<FleetWorkspace\s+\{\.\.\.fleet\}\s*\/>[\s\S]*<\/Suspense>/
        );
        expect(fleetBranch).not.toMatch(/\bhidden\b|display\s*:\s*none|<Activity\b/);
        expect(workspace).not.toMatch(
            /FleetWorkspace|(?:from\s+|import\()['"][^'"]*\/fleet\//
        );
        expect(activeWork.match(/switch\s*\(view\)/g)).toHaveLength(1);
    });

    test('passes only the typed root control, selection, URL, and inspector seams', () => {
        const contract = source(fleetContractPath);
        const workspace = source(workspacePath);
        const propBody = contract.match(
            /export type FleetWorkspaceProps\s*=\s*Readonly<\{([\s\S]*?)\}>;/
        )?.[1] ?? '';
        // Indentation-agnostic: the formatter owns the width, so match a declaration at whatever
        // depth the sole nesting level of this flat prop type happens to sit at.
        const propNames = [...propBody.matchAll(
            /^[^\S\r\n]+(\w+)(?:\??:|\()/gmu
        )].map((match) => match[1]);

        expect(propNames).toEqual([
            'connection',
            'selection',
            'urlState',
            'navigate',
            'replace',
            'onInspect',
            'onInspectorChange',
            'onSelectionLabelChange'
        ]);
        expect(workspace).toMatch(/fleet=\{\{[\s\S]*?connection:\s*control\.connection,/);
        expect(workspace).toMatch(/fleet=\{\{[\s\S]*?selection:\s*control\.selection,/);
        expect(workspace).toMatch(/fleet=\{\{[\s\S]*?urlState:\s*urlState\.state,/);
        expect(workspace).toMatch(/fleet=\{\{[\s\S]*?navigate:\s*urlState\.navigate,/);
        expect(workspace).toMatch(/fleet=\{\{[\s\S]*?replace:\s*urlState\.replace,/);
        expect(workspace).toMatch(/fleet=\{\{[\s\S]*?onInspect:\s*inspectEvidence,/);
        expect(workspace).toMatch(/fleet=\{\{[\s\S]*?onInspectorChange:\s*setInspectorContent,/);
        expect(workspace).toMatch(/fleet=\{\{[\s\S]*?onSelectionLabelChange:\s*setSelectionLabel,/);
    });

    test('keeps the compatibility marker on a focused composition-only Fleet root', () => {
        const fleetWorkspace = source(fleetWorkspacePath);

        expect(fleetWorkspace).toMatch(/export default function FleetWorkspace\b/);
        expect(fleetWorkspace).toContain('data-preview-view="fleet"');
        expect(fleetWorkspace).toContain('data-fleet-workspace');
        expect(fleetWorkspace).toContain('<FleetWorkspaceEvidence');
        expect(fleetWorkspace).not.toMatch(
            /deriveFleet|validateControlFleet|fetchFleet|useControl|useEffect|useState/
        );
        expect(existsSync(resolve(repositoryRoot, `${fleetRoot}/FleetPreview.tsx`)))
            .toBe(false);
    });

    test('keeps Fleet isolated from legacy, duplicate I/O, global state, and global CSS', () => {
        const owners = filesBelow(fleetRoot)
            .filter((path) => /\.(?:ts|tsx|css)$/.test(path))
            .sort();
        const ownerSources = owners
            .filter((path) => /\.tsx?$/.test(path))
            .map((path) => [path, source(path)] as const);
        const allSources = ownerSources.map(([, file]) => file).join('\n');

        expect(allSources).not.toMatch(
            /(?:from\s+|import\()['"][^'"]*legacy\/|\bfetch\s*\(|\bsetInterval\s*\(|\bsetTimeout\s*\(|\buseRecipeConsoleControlWorkspace\b|\buseControlConnection\b|\bcreateContext\b|\blocalStorage\b|\bsessionStorage\b|\b(?:manualToken|controlToken|controlUrl)\b/
        );
        const cssImports = ownerSources.flatMap(([path, file]) =>
            importedSpecifiers(file)
                .filter((specifier) => specifier.endsWith('.css'))
                .map((specifier) => ({ path, specifier }))
        );
        expect(cssImports.length).toBeGreaterThan(0);
        for (const { path, specifier } of cssImports) {
            expect(specifier, path).toMatch(/^\.\/.+\.module\.css$/);
            expect(
                resolve(repositoryRoot, dirname(path), specifier).startsWith(
                    resolve(repositoryRoot, fleetRoot)
                ),
                `${path}: ${specifier}`
            ).toBe(true);
        }
        expect(
            owners.filter((path) => path.endsWith('.css')).every(
                (path) => path.endsWith('.module.css')
            )
        ).toBe(true);
    });

    test('uses a focused DAG, reusable owning-window anchor, and strict line caps', () => {
        const fleetWorkspace = source(fleetWorkspacePath);
        const workspace = source(workspacePath);
        const focusAnchor = source(focusAnchorPath);

        expect(importedSpecifiers(fleetWorkspace).sort()).toEqual([
            './FleetWorkspace.module.css',
            './FleetWorkspaceEvidence.tsx',
            './fleet-workspace-contract.ts',
            './use-fleet-inspection-host.tsx',
            './use-fleet-workspace-actions.ts',
            './use-fleet-workspace.ts'
        ]);
        expect(workspace).toMatch(
            /import\s*\{\s*owningWindowFocusAnchor\s*\}\s*from\s*['"]\.\.\/ui\/owning-window-focus-anchor\.ts['"]/
        );
        expect(workspace).toContain(
            'setInspectorTriggerFallback(owningWindowFocusAnchor(trigger))'
        );
        expect(workspace).not.toContain('function owningWindowRangeAnchor');
        expect(focusAnchor).toContain('data-monitor-window-owner');
        expect(focusAnchor).toContain('data-monitor-window-focus-anchor');
        expect(focusAnchor).toContain('data-fleet-window-owner');
        expect(focusAnchor).toContain('data-fleet-window-focus-anchor');
        expect(focusAnchor).toContain('data-recipe-console-shell');

        expect(lines(activeWorkPath), activeWorkPath).toBeLessThanOrEqual(100);
        expect(lines(workspacePath), workspacePath).toBeLessThanOrEqual(220);
        expect(lines(fleetWorkspacePath), fleetWorkspacePath)
            .toBeLessThanOrEqual(80);
        expect(lines(fleetContractPath), fleetContractPath)
            .toBeLessThanOrEqual(80);
        expect(lines(focusAnchorPath), focusAnchorPath).toBeLessThanOrEqual(80);
        // Re-baselined after the dprint reformat: the largest file here grew 297 -> 322 lines on
        // formatting alone. The cap still bounds growth, at the layout the formatter now produces.
        for (const path of filesBelow(fleetRoot).filter((path) => /\.tsx?$/.test(path))) {
            expect(lines(path), path).toBeLessThanOrEqual(330);
        }
    });
});
