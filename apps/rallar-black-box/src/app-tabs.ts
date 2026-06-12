export const APP_MODES = [
    {
        id: 'rallar',
        label: 'Rallar',
        description: 'Direct live Rallar operations',
    },
    {
        id: 'black-box-runner',
        label: 'Rallar black-box-runner',
        description: 'Recipes, control runs, and artifacts',
    },
] as const;

export type AppModeId = (typeof APP_MODES)[number]['id'];

export const DEFAULT_APP_MODE_ID: AppModeId = 'rallar';

export const APP_TABS = [
    { id: 'quick-test', label: 'Quick Test' },
    { id: 'auth', label: 'Auth' },
    { id: 'manual-rallar', label: 'Manual Rallar' },
    { id: 'rooms-clients', label: 'Groups/Clients' },
    { id: 'websocket', label: 'WebSocket' },
    { id: 'rtc-realtime', label: 'RTC/Realtimes' },
    { id: 'topology', label: 'Topology' },
    { id: 'rtc-diagnostics', label: 'RTC Diagnostics' },
    { id: 'rallar-data', label: 'Rallar Data' },
    { id: 'crdt-health', label: 'CRDT' },
    { id: 'media', label: 'Media' },
    { id: 'local-workbench', label: 'Local Workbench' },
    { id: 'run-manager', label: 'Run Manager' },
    { id: 'distributed-recipes', label: 'Distributed Recipes' },
    { id: 'rallar-trace', label: 'Rallar Trace' },
    { id: 'event-stream', label: 'Event Stream' },
    { id: 'rallar-server', label: 'Rallar Server' },
    { id: 'flow-builder', label: 'Flow Builder' },
    { id: 'shared-test', label: 'Shared Test' },
    { id: 'recipes', label: 'Recipes' },
    { id: 'runs', label: 'Runs' },
    { id: 'fleet', label: 'Fleet' },
    { id: 'builder', label: 'Builder' },
    { id: 'advanced', label: 'Advanced' },
] as const;

export type AppTabId = (typeof APP_TABS)[number]['id'];

export const DEFAULT_APP_TAB_ID: AppTabId = 'quick-test';

export type RunnerAdvancedSurfaceId =
    | 'manual'
    | 'workbench'
    | 'run-manager'
    | 'distributed'
    | 'shared-test';

const LEGACY_RUNNER_ADVANCED_TAB_TARGETS: Partial<
    Readonly<Record<AppTabId, RunnerAdvancedSurfaceId>>
> = {
    'manual-rallar': 'manual',
    'local-workbench': 'workbench',
    'run-manager': 'run-manager',
    'distributed-recipes': 'distributed',
    'shared-test': 'shared-test',
};

const LEGACY_RUNNER_VISIBLE_TAB_TARGETS: Partial<
    Readonly<Record<AppTabId, AppTabId>>
> = {
    'manual-rallar': 'advanced',
    'local-workbench': 'advanced',
    'run-manager': 'advanced',
    'distributed-recipes': 'advanced',
    'shared-test': 'advanced',
    'flow-builder': 'builder',
};

const RALLAR_MODE_TAB_IDS = [
    'quick-test',
    'auth',
    'rooms-clients',
    'websocket',
    'rtc-realtime',
    'topology',
    'rtc-diagnostics',
    'rallar-data',
    'crdt-health',
    'media',
    'rallar-server',
    'rallar-trace',
    'event-stream',
] as const satisfies readonly AppTabId[];

const BLACK_BOX_RUNNER_MODE_TAB_IDS = [
    'recipes',
    'runs',
    'fleet',
    'builder',
    'event-stream',
    'advanced',
] as const satisfies readonly AppTabId[];

const MODE_TAB_IDS: Readonly<Record<AppModeId, readonly AppTabId[]>> = {
    rallar: RALLAR_MODE_TAB_IDS,
    'black-box-runner': BLACK_BOX_RUNNER_MODE_TAB_IDS,
};

const MODE_DEFAULT_TABS: Readonly<Record<AppModeId, AppTabId>> = {
    rallar: 'quick-test',
    'black-box-runner': 'recipes',
};

const TAB_PRIMARY_MODE: Readonly<Record<AppTabId, AppModeId>> = {
    'quick-test': 'rallar',
    auth: 'rallar',
    'manual-rallar': 'black-box-runner',
    'rooms-clients': 'rallar',
    websocket: 'rallar',
    'rtc-realtime': 'rallar',
    topology: 'rallar',
    'rtc-diagnostics': 'rallar',
    'rallar-data': 'rallar',
    'crdt-health': 'rallar',
    media: 'rallar',
    'rallar-trace': 'rallar',
    'rallar-server': 'rallar',
    'event-stream': 'rallar',
    'local-workbench': 'black-box-runner',
    'run-manager': 'black-box-runner',
    'distributed-recipes': 'black-box-runner',
    'flow-builder': 'black-box-runner',
    'shared-test': 'black-box-runner',
    recipes: 'black-box-runner',
    runs: 'black-box-runner',
    fleet: 'black-box-runner',
    builder: 'black-box-runner',
    advanced: 'black-box-runner',
};

const MODE_ALIASES: Readonly<Record<string, AppModeId>> = {
    direct: 'rallar',
    live: 'rallar',
    rallar: 'rallar',
    runner: 'black-box-runner',
    'black-box': 'black-box-runner',
    'black-box-runner': 'black-box-runner',
    blackbox: 'black-box-runner',
    recipes: 'black-box-runner',
    shared: 'black-box-runner',
    tests: 'black-box-runner',
};

const TAB_ALIASES: Readonly<Record<string, AppTabId>> = {
    quick: 'quick-test',
    smoke: 'quick-test',
    'quick-test': 'quick-test',
    login: 'auth',
    session: 'auth',
    manual: 'manual-rallar',
    rallar: 'quick-test',
    rooms: 'rooms-clients',
    groups: 'rooms-clients',
    clients: 'rooms-clients',
    people: 'rooms-clients',
    presence: 'rooms-clients',
    ws: 'websocket',
    socket: 'websocket',
    websocket: 'websocket',
    websockets: 'websocket',
    realtime: 'rtc-realtime',
    rtcrealtime: 'rtc-realtime',
    'rtc-realtime': 'rtc-realtime',
    rtc: 'rtc-diagnostics',
    diagnostics: 'rtc-diagnostics',
    data: 'rallar-data',
    'rallar-data': 'rallar-data',
    storage: 'rallar-data',
    crdt: 'crdt-health',
    'crdt-health': 'crdt-health',
    collaboration: 'crdt-health',
    media: 'media',
    workbench: 'local-workbench',
    local: 'local-workbench',
    runs: 'runs',
    fleet: 'fleet',
    'fleet-report': 'fleet',
    'fleet-reports': 'fleet',
    manager: 'run-manager',
    control: 'run-manager',
    orchestrator: 'run-manager',
    distributed: 'distributed-recipes',
    'distributed-recipes': 'distributed-recipes',
    'distributed-runs': 'distributed-recipes',
    dist: 'distributed-recipes',
    events: 'event-stream',
    event: 'event-stream',
    trace: 'rallar-trace',
    'rallar-trace': 'rallar-trace',
    rallartrace: 'rallar-trace',
    server: 'rallar-server',
    flow: 'builder',
    flows: 'flow-builder',
    builder: 'builder',
    catalog: 'recipes',
    recipes: 'recipes',
    artifacts: 'shared-test',
    shared: 'shared-test',
    'shared-test-runner': 'shared-test',
    advanced: 'advanced',
    debug: 'advanced',
};

export function appModeFromValue(value: string | null | undefined): AppModeId {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) {
        return DEFAULT_APP_MODE_ID;
    }

    const mode = APP_MODES.find((entry) => entry.id === normalized);
    if (mode) {
        return mode.id;
    }

    return MODE_ALIASES[normalized] ?? DEFAULT_APP_MODE_ID;
}

export function appTabFromValue(value: string | null | undefined): AppTabId {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) {
        return DEFAULT_APP_TAB_ID;
    }

    const tab = APP_TABS.find((entry) => entry.id === normalized);
    if (tab) {
        return tab.id;
    }

    return TAB_ALIASES[normalized] ?? DEFAULT_APP_TAB_ID;
}

export function appTabsForMode(
    mode: AppModeId,
): readonly (typeof APP_TABS)[number][] {
    const tabIds = MODE_TAB_IDS[mode];
    return tabIds
        .map((tabId) => APP_TABS.find((tab) => tab.id === tabId))
        .filter((tab): tab is (typeof APP_TABS)[number] => Boolean(tab));
}

export function appTabInMode(tab: AppTabId, mode: AppModeId): boolean {
    return MODE_TAB_IDS[mode].includes(tab);
}

export function visibleAppTabForTab(tab: AppTabId): AppTabId {
    return LEGACY_RUNNER_VISIBLE_TAB_TARGETS[tab] ?? tab;
}

export function runnerAdvancedSurfaceForTab(tab: AppTabId): RunnerAdvancedSurfaceId | undefined {
    return LEGACY_RUNNER_ADVANCED_TAB_TARGETS[tab];
}

export function appModeForTab(tab: AppTabId): AppModeId {
    return TAB_PRIMARY_MODE[tab];
}

export function defaultAppTabForMode(mode: AppModeId): AppTabId {
    return MODE_DEFAULT_TABS[mode];
}

export function nextAppTab(
    current: AppTabId,
    direction: -1 | 1,
    mode: AppModeId = appModeForTab(current),
): AppTabId {
    const tabs = appTabsForMode(mode);
    const currentIndex = tabs.findIndex((entry) => entry.id === current);
    const startIndex = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = (startIndex + direction + tabs.length) % tabs.length;
    return tabs[nextIndex].id;
}
