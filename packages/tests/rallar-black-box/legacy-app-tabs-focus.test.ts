// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppTabId } from '../../../apps/rallar-black-box/src/app-tabs.ts';
import { AppTabs } from '../../../apps/rallar-black-box/src/legacy/shell/AppTabs.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const RUNNER_TABS = [
    'recipes',
    'runs',
    'fleet',
    'builder',
    'event-stream',
    'advanced'
] as const satisfies readonly AppTabId[];

function AppTabsHarness({ initialTab = 'fleet' }: { initialTab?: AppTabId; }) {
    const [activeTab, setActiveTab] = useState<AppTabId>(initialTab);

    return createElement(
        'main',
        {},
        createElement(AppTabs, {
            activeMode: 'black-box-runner',
            activeTab,
            onSelect: setActiveTab
        }),
        createElement(
            'section',
            {
                key: activeTab,
                id: `panel-${activeTab}`,
                role: 'tabpanel',
                'aria-labelledby': `tab-${activeTab}`
            },
            activeTab === 'recipes'
                ? createElement(
                    'button',
                    {
                        type: 'button',
                        onClick: () => setActiveTab('advanced')
                    },
                    'Open Advanced'
                )
                : `${activeTab} panel`
        )
    );
}

function RetainedDirectTabsHarness() {
    const [activeTab, setActiveTab] = useState<AppTabId>('quick-test');

    return createElement(
        'main',
        {},
        createElement(AppTabs, {
            activeMode: 'rallar',
            activeTab,
            onSelect: setActiveTab
        }),
        createElement(
            'section',
            {
                hidden: activeTab !== 'quick-test',
                id: 'panel-quick-test',
                role: 'tabpanel'
            },
            createElement(
                'button',
                { type: 'button', onClick: () => setActiveTab('auth') },
                'Open Auth'
            )
        ),
        createElement(
            'section',
            {
                hidden: activeTab !== 'auth',
                id: 'panel-auth',
                role: 'tabpanel'
            },
            'Auth panel'
        )
    );
}

function tab(container: HTMLElement, name: string): HTMLButtonElement {
    const match = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((element) => element.textContent === name);
    if (!match) {
        throw new Error(`Missing ${name} tab`);
    }
    return match;
}

describe('legacy AppTabs focus', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    it.each(
        [
            ['ArrowRight', 'Builder'],
            ['ArrowLeft', 'Runs'],
            ['Home', 'Recipes'],
            ['End', 'Advanced']
        ] as const
    )('%s selects and focuses the roving tab target', async (key, targetLabel) => {
        await act(async () => root.render(createElement(AppTabsHarness)));
        const source = tab(container, 'Fleet');
        source.focus();

        await act(async () =>
            source.dispatchEvent(
                new KeyboardEvent('keydown', {
                    bubbles: true,
                    cancelable: true,
                    key
                })
            )
        );

        const target = tab(container, targetLabel);
        expect(target.getAttribute('aria-selected')).toBe('true');
        expect(target.tabIndex).toBe(0);
        expect(document.activeElement).toBe(target);
        const controlledPanel = target.getAttribute('aria-controls');
        expect(controlledPanel).toBeTruthy();
        expect(document.getElementById(controlledPanel ?? '')).toBeTruthy();
        for (const id of RUNNER_TABS) {
            expect(
                tab(
                    container,
                    id === 'event-stream'
                        ? 'Event Stream'
                        : id[0].toUpperCase() + id.slice(1)
                ).tabIndex
            )
                .toBe(target.id === `tab-${id}` ? 0 : -1);
        }
    });

    it('returns focus to the selected tab when a panel launch control unmounts', async () => {
        await act(async () =>
            root.render(createElement(AppTabsHarness, {
                initialTab: 'recipes'
            }))
        );
        const launch = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find((element) => element.textContent === 'Open Advanced');
        if (!launch) {
            throw new Error('Missing panel launch control');
        }
        launch.focus();

        await act(async () => launch.click());

        expect(launch.isConnected).toBe(false);
        const advanced = tab(container, 'Advanced');
        expect(advanced.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(advanced);
    });

    it('returns focus when a retained panel launch control becomes hidden', async () => {
        await act(async () =>
            root.render(createElement(
                RetainedDirectTabsHarness
            ))
        );
        const launch = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find((element) => element.textContent === 'Open Auth');
        if (!launch) {
            throw new Error('Missing retained panel launch control');
        }
        launch.focus();

        await act(async () => launch.click());

        expect(launch.isConnected).toBe(true);
        expect(launch.closest('section')?.hidden).toBe(true);
        const auth = tab(container, 'Auth');
        expect(auth.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(auth);
    });
});
