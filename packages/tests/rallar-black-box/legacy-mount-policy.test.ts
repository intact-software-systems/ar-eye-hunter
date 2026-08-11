// @vitest-environment happy-dom

import {
    createElement,
    type ComponentProps,
    type ComponentType,
    useEffect,
} from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const lifecycle = {
    events: [] as string[],
};

function lifecycleModule(
    component: string,
): () => Record<string, ComponentType> {
    return () => {
        const LifecycleLeaf = () => {
            useEffect(() => {
                lifecycle.events.push(`mount:${component}`);
                return () => lifecycle.events.push(`unmount:${component}`);
            }, []);
            return createElement('div', { 'data-legacy-leaf': component }, component);
        };
        return { [component]: LifecycleLeaf };
    };
}

type AdvancedPanel = typeof import(
    '../../../apps/rallar-black-box/src/legacy/runner/advanced/RunnerAdvancedPanel.tsx'
)['RunnerAdvancedPanel'];
type DirectPanels = typeof import(
    '../../../apps/rallar-black-box/src/legacy/shell/tabs/DirectConnectionTabPanels.tsx'
)['DirectConnectionTabPanels'];

let RunnerAdvancedPanel: AdvancedPanel;
let DirectConnectionTabPanels: DirectPanels;
let root: Root | undefined;
let container: HTMLDivElement;

beforeAll(async () => {
    vi.doMock(
        '../../../apps/rallar-black-box/src/legacy/runner/distributed-recipes/DistributedRecipesPanel.tsx',
        lifecycleModule('DistributedRecipesPanel'),
    );
    vi.doMock(
        '../../../apps/rallar-black-box/src/legacy/runner/run-manager/RunManagerPanel.tsx',
        lifecycleModule('RunManagerPanel'),
    );
    vi.doMock(
        '../../../apps/rallar-black-box/src/legacy/runner/shared-test/SharedTestPanel.tsx',
        lifecycleModule('SharedTestPanel'),
    );
    vi.doMock(
        '../../../apps/rallar-black-box/src/legacy/runner/workbench/LocalWorkbenchSection.tsx',
        lifecycleModule('LocalWorkbenchSection'),
    );
    vi.doMock(
        '../../../apps/rallar-black-box/src/legacy/runner/manual/ManualRallarSection.tsx',
        lifecycleModule('ManualRallarSection'),
    );
    vi.doMock(
        '../../../apps/rallar-black-box/src/legacy/diagnostics/rooms-clients/RoomsClientsPanel.tsx',
        lifecycleModule('RoomsClientsPanel'),
    );
    vi.doMock(
        '../../../apps/rallar-black-box/src/legacy/diagnostics/topology/TopologyGraphPanel.tsx',
        lifecycleModule('TopologyGraphPanel'),
    );
    vi.doMock(
        '../../../apps/rallar-black-box/src/legacy/diagnostics/rtc/RtcDiagnosticsPanel.tsx',
        lifecycleModule('RtcDiagnosticsPanel'),
    );
    vi.doMock(
        '../../../apps/rallar-black-box/src/legacy/diagnostics/quick-test/QuickRallarTestPanel.tsx',
        lifecycleModule('QuickRallarTestPanel'),
    );
    vi.doMock(
        '../../../apps/rallar-black-box/src/legacy/diagnostics/auth/AuthCommandCenterPanel.tsx',
        lifecycleModule('AuthCommandCenterPanel'),
    );
    vi.doMock(
        '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/WebSocketCommandCenterPanel.tsx',
        lifecycleModule('WebSocketCommandCenterPanel'),
    );
    vi.doMock(
        '../../../apps/rallar-black-box/src/legacy/diagnostics/rtc-realtime/RtcRealtimePanel.tsx',
        lifecycleModule('RtcRealtimePanel'),
    );
    vi.doMock(
        '../../../apps/rallar-black-box/src/legacy/diagnostics/events/StatsPanel.tsx',
        lifecycleModule('StatsPanel'),
    );
    vi.doMock(
        '../../../apps/rallar-black-box/src/legacy/runner/runs/FailurePanel.tsx',
        lifecycleModule('FailurePanel'),
    );

    await Promise.all([
        import(
            '../../../apps/rallar-black-box/src/legacy/runner/distributed-recipes/DistributedRecipesPanel.tsx'
        ),
        import(
            '../../../apps/rallar-black-box/src/legacy/diagnostics/rooms-clients/RoomsClientsPanel.tsx'
        ),
        import(
            '../../../apps/rallar-black-box/src/legacy/diagnostics/topology/TopologyGraphPanel.tsx'
        ),
    ]);

    ({ RunnerAdvancedPanel } = await import(
        '../../../apps/rallar-black-box/src/legacy/runner/advanced/RunnerAdvancedPanel.tsx'
    ));
    ({ DirectConnectionTabPanels } = await import(
        '../../../apps/rallar-black-box/src/legacy/shell/tabs/DirectConnectionTabPanels.tsx'
    ));
});

beforeEach(() => {
    lifecycle.events = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    container.remove();
});

describe('legacy view mount policy', () => {
    it('unmounts an Advanced safe leaf when Advanced becomes inactive', async () => {
        const props = advancedProps();
        await act(async () => root?.render(createElement(RunnerAdvancedPanel, {
            ...props,
            active: true,
            initialSurface: 'distributed',
        })));
        await flushLazyMount();

        expect(
            container.querySelector('[data-legacy-leaf="DistributedRecipesPanel"]'),
            container.innerHTML,
        )
            .not.toBeNull();
        expect(lifecycle.events).toContain('mount:DistributedRecipesPanel');
        expect(lifecycle.events).toContain('mount:LocalWorkbenchSection');
        expect(lifecycle.events).toContain('mount:ManualRallarSection');

        await act(async () => root?.render(createElement(RunnerAdvancedPanel, {
            ...props,
            active: false,
            initialSurface: 'distributed',
        })));

        expect(container.querySelector('[data-legacy-leaf="DistributedRecipesPanel"]'))
            .toBeNull();
        expect(lifecycle.events).toContain('unmount:DistributedRecipesPanel');
        expect(lifecycle.events).not.toContain('unmount:LocalWorkbenchSection');
        expect(lifecycle.events).not.toContain('unmount:ManualRallarSection');
    });

    it('unmounts safe direct leaves while retaining documented exceptions', async () => {
        const props = directProps('rooms-clients');
        await act(async () => root?.render(
            createElement(DirectConnectionTabPanels, props),
        ));
        await flushLazyMount();

        expect(
            container.querySelector('[data-legacy-leaf="RoomsClientsPanel"]'),
            container.innerHTML,
        )
            .not.toBeNull();
        for (const component of [
            'QuickRallarTestPanel',
            'AuthCommandCenterPanel',
            'WebSocketCommandCenterPanel',
            'RtcRealtimePanel',
        ]) {
            expect(lifecycle.events, `${component} mounted`).toContain(
                `mount:${component}`,
            );
        }

        await act(async () => root?.render(
            createElement(DirectConnectionTabPanels, directProps('topology')),
        ));
        await flushLazyMount();

        expect(container.querySelector('[data-legacy-leaf="RoomsClientsPanel"]'))
            .toBeNull();
        expect(container.querySelector('[data-legacy-leaf="TopologyGraphPanel"]'))
            .not.toBeNull();
        expect(lifecycle.events).toContain('unmount:RoomsClientsPanel');
        for (const component of [
            'QuickRallarTestPanel',
            'AuthCommandCenterPanel',
            'WebSocketCommandCenterPanel',
            'RtcRealtimePanel',
        ]) {
            expect(lifecycle.events, `${component} retained`).not.toContain(
                `unmount:${component}`,
            );
        }
    });
});

async function flushLazyMount(): Promise<void> {
    await act(async () => {
        await new Promise(resolve => window.setTimeout(resolve, 0));
    });
}

function advancedProps() {
    return {
        state: { commandHistory: [] },
        bootstrap: {},
        control: {},
        globalValues: {},
        globalValuesEdited: false,
        busy: false,
        runState: 'waiting',
        queueRows: [],
        onSelectCommand: vi.fn(),
        onGlobalValueChange: vi.fn(),
        onSurfaceChange: vi.fn(),
    } as unknown as Omit<ComponentProps<AdvancedPanel>, 'active'>;
}

function directProps(activeTab: string) {
    return {
        runtime: { state: {}, bootstrap: {}, busy: false },
        auth: {
            setAuthSession: vi.fn(),
            logout: vi.fn(),
        },
        navigation: {
            activeTab,
            selectTab: vi.fn(),
            selectMode: vi.fn(),
        },
        globalContext: {
            globalValues: {},
            browserStatus: {},
            updateGlobalValue: vi.fn(),
        },
        runnerSelection: { setSelectedCommandId: vi.fn() },
    } as unknown as ComponentProps<DirectPanels>;
}
