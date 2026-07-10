// @vitest-environment happy-dom

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const ownerPaths = {
    workspace:
        'apps/rallar-black-box/src/legacy/shell/tabs/RunnerWorkspaceTabPanels.tsx',
    advanced:
        'apps/rallar-black-box/src/legacy/runner/advanced/RunnerAdvancedPanel.tsx',
    direct:
        'apps/rallar-black-box/src/legacy/shell/tabs/DirectConnectionTabPanels.tsx',
} as const;

const safeTargets = [
    {
        owner: 'workspace',
        component: 'RunnerRecipesPanel',
        module: '../../runner/recipes/RunnerRecipesPanel.tsx',
        routeGuard: "activeTab === 'recipes'",
        sectionId: 'panel-recipes',
    },
    {
        owner: 'workspace',
        component: 'RunnerRunsPanel',
        module: '../../runner/runs/RunnerRunsPanel.tsx',
        routeGuard: "activeTab === 'runs'",
        sectionId: 'panel-runs',
    },
    {
        owner: 'workspace',
        component: 'RunnerFleetPanel',
        module: '../../runner/fleet/RunnerFleetPanel.tsx',
        routeGuard: "activeTab === 'fleet'",
        sectionId: 'panel-fleet',
    },
    {
        owner: 'workspace',
        component: 'FlowBuilderPanel',
        module: '../../runner/builder/FlowBuilderPanel.tsx',
        routeGuard: "activeTab === 'builder'",
        sectionId: 'panel-builder',
    },
    {
        owner: 'advanced',
        component: 'DistributedRecipesPanel',
        module: '../distributed-recipes/DistributedRecipesPanel.tsx',
        routeGuard: "surface === 'distributed'",
        sectionId: 'panel-distributed-recipes',
    },
    {
        owner: 'advanced',
        component: 'RunManagerPanel',
        module: '../run-manager/RunManagerPanel.tsx',
        routeGuard: "surface === 'run-manager'",
        sectionId: 'panel-run-manager',
    },
    {
        owner: 'advanced',
        component: 'SharedTestPanel',
        module: '../shared-test/SharedTestPanel.tsx',
        routeGuard: "surface === 'shared-test'",
        sectionId: 'panel-shared-test',
    },
    {
        owner: 'direct',
        component: 'RoomsClientsPanel',
        module: '../../diagnostics/rooms-clients/RoomsClientsPanel.tsx',
        routeGuard: "activeTab === 'rooms-clients'",
        sectionId: 'panel-rooms-clients',
    },
    {
        owner: 'direct',
        component: 'TopologyGraphPanel',
        module: '../../diagnostics/topology/TopologyGraphPanel.tsx',
        routeGuard: "activeTab === 'topology'",
        sectionId: 'panel-topology',
    },
    {
        owner: 'direct',
        component: 'RtcDiagnosticsPanel',
        module: '../../diagnostics/rtc/RtcDiagnosticsPanel.tsx',
        routeGuard: "activeTab === 'rtc-diagnostics'",
        sectionId: 'panel-rtc-diagnostics',
    },
] as const;

const statefulExceptions = [
    {
        owner: 'direct',
        component: 'QuickRallarTestPanel',
        module: '../../diagnostics/quick-test/QuickRallarTestPanel.tsx',
    },
    {
        owner: 'direct',
        component: 'AuthCommandCenterPanel',
        module: '../../diagnostics/auth/AuthCommandCenterPanel.tsx',
    },
    {
        owner: 'direct',
        component: 'WebSocketCommandCenterPanel',
        module: '../../diagnostics/websocket/WebSocketCommandCenterPanel.tsx',
    },
    {
        owner: 'direct',
        component: 'RtcRealtimePanel',
        module: '../../diagnostics/rtc-realtime/RtcRealtimePanel.tsx',
    },
    {
        owner: 'advanced',
        component: 'LocalWorkbenchSection',
        module: '../workbench/LocalWorkbenchSection.tsx',
    },
    {
        owner: 'advanced',
        component: 'ManualRallarSection',
        module: '../manual/ManualRallarSection.tsx',
    },
] as const;

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
    const sources = Object.fromEntries(
        Object.entries(ownerPaths).map(([owner, path]) => [
            owner,
            readFileSync(resolve(repositoryRoot, path), 'utf8'),
        ]),
    ) as Record<keyof typeof ownerPaths, string>;

    it('resolves every safe legacy route through a local dynamic import only', () => {
        for (const target of safeTargets) {
            const source = sources[target.owner];
            expect.soft(
                source,
                `${target.component}: dynamic import`,
            ).toContain(`import('${target.module}')`);
            expect.soft(
                source,
                `${target.component}: no static value import`,
            ).not.toMatch(new RegExp(
                `import\\s+\\{[^}]*\\b${target.component}\\b[^}]*\\}\\s+from\\s+['"]${escapeRegex(target.module)}['"]`,
            ));
            expect.soft(source, `${target.component}: lazy owner`).toMatch(
                new RegExp(
                    `lazy\\([\\s\\S]{0,240}import\\(['"]${escapeRegex(target.module)}['"]\\)`,
                ),
            );
        }
    });

    it('mounts every safe target only inside its active route guard', () => {
        for (const target of safeTargets) {
            const source = sources[target.owner];
            const section = routeElementSource(source, target.sectionId);

            expect.soft(section, `${target.sectionId}: section exists`).not.toBe('');
            expect.soft(section, `${target.sectionId}: no hidden mount`).not.toMatch(
                /\bhidden\s*=/,
            );
            expect.soft(
                source.slice(
                    Math.max(0, source.indexOf(`id="${target.sectionId}"`) - 240),
                    source.indexOf(`id="${target.sectionId}"`) + section.length,
                ),
                `${target.sectionId}: active-only guard`,
            ).toContain(target.routeGuard);
            expect.soft(section, `${target.component}: one mounted leaf`).toMatch(
                new RegExp(`<${target.component}\\b`),
            );
        }
    });

    it('keeps registered stateful exceptions static and view-owned', () => {
        for (const target of statefulExceptions) {
            const source = sources[target.owner];
            expect.soft(source, `${target.component}: static import`).toMatch(
                new RegExp(
                    `import\\s+\\{[^}]*\\b${target.component}\\b[^}]*\\}\\s+from\\s+['"]${escapeRegex(target.module)}['"]`,
                ),
            );
            expect.soft(source, `${target.component}: no dynamic split`).not.toContain(
                `import('${target.module}')`,
            );
            expect.soft(
                [...source.matchAll(new RegExp(`<${target.component}\\b`, 'g'))],
                `${target.component}: single owner call`,
            ).toHaveLength(1);
        }
    });

    it('keeps the lazy Runs entry out of static evidence ownership', () => {
        const runsPath =
            'apps/rallar-black-box/src/legacy/runner/runs/RunnerRunsPanel.tsx';
        const failurePath =
            'apps/rallar-black-box/src/legacy/runner/runs/FailurePanel.tsx';
        const directPath = ownerPaths.direct;
        const evidencePath =
            'apps/rallar-black-box/src/legacy/shell/tabs/DiagnosticEvidenceTabPanels.tsx';
        const failureExists = existsSync(resolve(repositoryRoot, failurePath));
        const runsSource = readFileSync(resolve(repositoryRoot, runsPath), 'utf8');
        const failureSource = failureExists
            ? readFileSync(resolve(repositoryRoot, failurePath), 'utf8')
            : '';
        const evidenceSource = readFileSync(
            resolve(repositoryRoot, evidencePath),
            'utf8',
        );

        expect.soft(failureExists, 'focused FailurePanel owner').toBe(true);
        expect.soft(failureSource, 'focused FailurePanel export').toMatch(
            /^export function FailurePanel\(/m,
        );
        expect.soft(runsSource, 'Runs imports the evidence leaf').toContain(
            "import { FailurePanel } from './FailurePanel.tsx';",
        );
        expect.soft(runsSource, 'Runs keeps the public evidence export').toContain(
            "export { FailurePanel } from './FailurePanel.tsx';",
        );
        expect.soft(runsSource, 'Runs no longer declares the evidence leaf').not.toMatch(
            /^export function FailurePanel\(/m,
        );
        expect.soft(sources.direct, 'direct evidence import').toContain(
            "import { FailurePanel } from '../../runner/runs/FailurePanel.tsx';",
        );
        expect.soft(evidenceSource, 'event evidence import').toContain(
            "import { FailurePanel } from '../../runner/runs/FailurePanel.tsx';",
        );
    });

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

function routeElementSource(source: string, id: string): string {
    const start = source.indexOf(`id="${id}"`);
    if (start < 0) return '';
    const sectionOpen = source.lastIndexOf('<section', start);
    const divOpen = source.lastIndexOf('<div', start);
    const open = Math.max(sectionOpen, divOpen);
    const tag = open === sectionOpen ? 'section' : 'div';
    const closeMarker = `</${tag}>`;
    const close = source.indexOf(closeMarker, start);
    return open >= 0 && close >= 0
        ? source.slice(open, close + closeMarker.length)
        : '';
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
