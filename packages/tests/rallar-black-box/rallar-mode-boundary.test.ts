// @vitest-environment happy-dom

import { readdirSync } from 'node:fs';
import path from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';

import { appTabsForMode } from '../../../apps/rallar-black-box/src/app-tabs.ts';
import { analyzeSourceFile, resolveRelativeTypeScriptDependency } from '../helpers/source-analysis';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const DIRECT_RALLAR_TAB_GROUPS = [
    'apps/rallar-black-box/src/legacy/shell/tabs/direct-connection-tab-panels.tsx',
    'apps/rallar-black-box/src/legacy/shell/tabs/DirectResourceTabPanels.tsx',
    'apps/rallar-black-box/src/legacy/shell/tabs/diagnostic-evidence-tab-panels.tsx'
].map((relativePath) => path.resolve(repositoryRoot, relativePath));
const BLACK_BOX_RUNTIME_STORE = path.resolve(repositoryRoot, 'apps/rallar-black-box/src/runtime-store.ts');
const DIAGNOSTICS_SOURCE_ROOT = path.resolve(repositoryRoot, 'apps/rallar-black-box/src/legacy/diagnostics');
const BLACK_BOX_RUNTIME_COMMAND_NAMES: ReadonlySet<string> = new Set([
    'runManualCommand',
    'runManualCommands',
    'runCommandFromJsonText',
    'loadRecipeFromJson',
    'runLoadedRecipe',
    'runSample',
    '__blackBoxRallar',
    '__blackBoxRallarEmit',
    'createSpaBrowserRallarRuntime'
]);

/** The runtime store is the black-box boundary: panels may record events through it, so the walk stops there. */
function directPanelDependencyClosure(): readonly string[] {
    const visited = new Set<string>();
    const pending = [...DIRECT_RALLAR_TAB_GROUPS];
    while (pending.length > 0) {
        const filePath = pending.pop();
        if (filePath === undefined || visited.has(filePath) || filePath === BLACK_BOX_RUNTIME_STORE) {
            continue;
        }
        visited.add(filePath);
        const analysis = analyzeSourceFile(filePath);
        const specifiers = [
            ...analysis.imports.map((entry) => entry.specifier),
            ...analysis.exports.flatMap((entry) => entry.specifier ? [entry.specifier] : []),
            ...analysis.dynamicImports.flatMap((entry) => entry.literal && entry.specifier ? [entry.specifier] : [])
        ];
        pending.push(
            ...specifiers.flatMap((specifier) => resolveRelativeTypeScriptDependency(filePath, specifier) ?? [])
        );
    }
    return [...visited].sort();
}

describe('rallar-black-box Rallar mode boundary', () => {
    it('does not expose black-box-runner command tabs in Rallar mode', () => {
        const tabIds = appTabsForMode('rallar').map((tab) => tab.id);
        for (const runnerTab of ['manual-rallar', 'local-workbench', 'flow-builder', 'run-manager', 'shared-test']) {
            expect(tabIds).not.toContain(runnerTab);
        }
    });

    it('preserves existing event and command evidence when configuring the local workbench', async () => {
        window.history.replaceState({}, '', '/?provider=simulated');
        const { rallarBlackBoxRuntimeStore } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');
        await rallarBlackBoxRuntimeStore.configureLocalWorkbenchOnly();
        rallarBlackBoxRuntimeStore.recordRuntimeEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.before-workbench',
            payload: { publicValue: 'preserved' }
        });
        await rallarBlackBoxRuntimeStore.runManualCommands([
            { kind: 'health', commandId: 'before-workbench', metadata: { localDelayMs: 0 } }
        ], 'Read health before local reconfiguration');
        const previousState = rallarBlackBoxRuntimeStore.getSnapshot().state;
        expect(previousState.commandHistory).toEqual(expect.arrayContaining([
            expect.objectContaining({ commandId: 'before-workbench', ok: true })
        ]));

        const previousCommands = [...previousState.commandHistory];
        const previousEvents = [...previousState.events];
        await rallarBlackBoxRuntimeStore.configureLocalWorkbenchOnly();

        const currentState = rallarBlackBoxRuntimeStore.getSnapshot().state;
        expect(currentState.commandHistory).toEqual(expect.arrayContaining(previousCommands));
        expect(currentState.commandHistory).toEqual(expect.arrayContaining([
            expect.objectContaining({ commandId: 'before-workbench', ok: true })
        ]));
        expect(currentState.events).toEqual(expect.arrayContaining(previousEvents));
        expect(currentState.events).toEqual(expect.arrayContaining([
            expect.objectContaining({ topic: 'rallar.browser.before-workbench', payload: { publicValue: 'preserved' } })
        ]));
        expect(rallarBlackBoxRuntimeStore.getSnapshot()).toMatchObject({ busy: false, bootstrapping: false });
    });

    it('keeps black-box runtime commands out of every module the direct Rallar tab groups load', () => {
        const closure = directPanelDependencyClosure();
        const actionOwners = readdirSync(DIAGNOSTICS_SOURCE_ROOT, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('-actions.ts'))
            .map((entry) => path.join(entry.parentPath, entry.name));
        const violations = closure.flatMap((filePath) => {
            const analysis = analyzeSourceFile(filePath);
            const commandNames = analysis.identifierNames.filter((name) => BLACK_BOX_RUNTIME_COMMAND_NAMES.has(name));
            const runtimeImports = [
                ...analysis.imports.map((entry) => entry.specifier),
                ...analysis.dynamicImports.flatMap((entry) => entry.specifier ? [entry.specifier] : [])
            ].filter((specifier) => specifier.includes('browser-rallar-runtime'));
            return [...new Set([...commandNames, ...runtimeImports])].map((name) => `${path.relative(repositoryRoot, filePath)}: ${name}`);
        });

        expect(actionOwners.filter((filePath) => !closure.includes(filePath))).toEqual([]);
        expect(violations).toEqual([]);
    });
});
