// @vitest-environment happy-dom

import {
    describe,
    expect,
    it
} from 'vitest';

import { appTabsForMode } from '../../../apps/rallar-black-box/src/app-tabs.ts';

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
});
