export type AdvancedSurfaceKind = 'direct' | 'advanced-legacy';

export type AdvancedSurfaceDescriptor = Readonly<{
    id: string;
    label: string;
    kind: AdvancedSurfaceKind;
    route: Readonly<{
        workspace: 'rallar' | 'black-box-runner';
        tab: string;
        advancedSurface?: string;
    }>;
    aliases: readonly string[];
}>;

export const ADVANCED_SURFACE_CATALOG = [
    directSurface(
        'direct.quick-test',
        'Quick Test',
        'quick-test',
        ['quick-test', 'quick', 'smoke', 'rallar'],
    ),
    directSurface(
        'direct.auth',
        'Auth',
        'auth',
        ['auth', 'login', 'session'],
    ),
    directSurface(
        'direct.groups-clients',
        'Groups/Clients',
        'rooms-clients',
        ['rooms-clients', 'rooms', 'groups', 'clients', 'people', 'presence'],
    ),
    directSurface(
        'direct.websocket',
        'WebSocket',
        'websocket',
        ['websocket', 'ws', 'socket', 'websockets'],
    ),
    directSurface(
        'direct.rtc-realtimes',
        'RTC/Realtimes',
        'rtc-realtime',
        ['rtc-realtime', 'realtime', 'rtcrealtime'],
    ),
    directSurface(
        'direct.topology',
        'Topology',
        'topology',
        ['topology'],
    ),
    directSurface(
        'direct.rtc-diagnostics',
        'RTC Diagnostics',
        'rtc-diagnostics',
        ['rtc-diagnostics', 'rtc', 'diagnostics'],
    ),
    directSurface(
        'direct.rallar-data',
        'Rallar Data',
        'rallar-data',
        ['rallar-data', 'data', 'storage'],
    ),
    directSurface(
        'direct.crdt',
        'CRDT',
        'crdt-health',
        ['crdt-health', 'crdt', 'collaboration'],
    ),
    directSurface(
        'direct.media',
        'Media',
        'media',
        ['media'],
    ),
    directSurface(
        'direct.rallar-server',
        'Rallar Server',
        'rallar-server',
        ['rallar-server', 'server'],
    ),
    directSurface(
        'direct.rallar-trace',
        'Rallar Trace',
        'rallar-trace',
        ['rallar-trace', 'trace', 'rallartrace'],
    ),
    directSurface(
        'diagnostic.event-stream',
        'Event Stream',
        'event-stream',
        ['event-stream', 'events', 'event'],
        'black-box-runner',
    ),
    runnerSurface(
        'runner.recipes',
        'Recipes',
        'recipes',
        ['recipes', 'catalog'],
    ),
    runnerSurface(
        'runner.runs',
        'Runs',
        'runs',
        ['runs'],
    ),
    runnerSurface(
        'runner.fleet',
        'Fleet',
        'fleet',
        ['fleet', 'fleet-report', 'fleet-reports'],
    ),
    runnerSurface(
        'runner.builder',
        'Flow Builder',
        'builder',
        ['builder', 'flow', 'flows', 'flow-builder'],
    ),
    advancedChild(
        'legacy.manual-rallar',
        'Manual Rallar',
        'manual',
        ['manual', 'manual-rallar'],
    ),
    advancedChild(
        'legacy.local-workbench',
        'Local Workbench',
        'workbench',
        ['workbench', 'local', 'local-workbench'],
    ),
    advancedChild(
        'legacy.run-manager',
        'Run Manager',
        'run-manager',
        ['run-manager', 'manager', 'control', 'orchestrator'],
    ),
    advancedChild(
        'legacy.distributed-recipes',
        'Distributed Recipes',
        'distributed',
        ['distributed', 'distributed-runs', 'dist', 'distributed-recipes'],
    ),
    advancedChild(
        'legacy.shared-test-catalog',
        'Shared Test',
        'shared-test',
        ['shared-test', 'artifacts', 'shared', 'shared-test-runner'],
    ),
] as const satisfies readonly AdvancedSurfaceDescriptor[];

export type AdvancedSurface = typeof ADVANCED_SURFACE_CATALOG[number];
export type AdvancedSurfaceId = AdvancedSurface['id'];

export function resolveAdvancedSurface(
    value: string | null | undefined,
): AdvancedSurface | undefined {
    const normalized = normalize(value);
    if (!normalized || normalized === 'advanced' || normalized === 'debug') {
        return undefined;
    }

    return ADVANCED_SURFACE_CATALOG.find(surface =>
        normalize(surface.id) === normalized ||
        surface.aliases.some(alias => normalize(alias) === normalized)
    );
}

export function resolveAdvancedSurfaceFromLegacySearch(
    search: string | URLSearchParams,
): AdvancedSurface | undefined {
    const params = search instanceof URLSearchParams
        ? search
        : new URLSearchParams(search);
    const stableSurface = resolveAdvancedSurface(params.get('legacySurface'));
    if (stableSurface) {
        return stableSurface;
    }

    const tab = normalize(params.get('tab'));
    const advancedSurface = params.get('advancedSurface') ??
        params.get('advanced');
    if (tab === 'advanced' || tab === 'debug') {
        return resolveAdvancedSurface(advancedSurface);
    }
    if (tab) {
        return resolveAdvancedSurface(tab);
    }
    return resolveAdvancedSurface(advancedSurface);
}

function directSurface<
    const Id extends string,
    const Label extends string,
    const Tab extends string,
    const Aliases extends readonly string[],
>(
    id: Id,
    label: Label,
    tab: Tab,
    aliases: Aliases,
    workspace: 'rallar' | 'black-box-runner' = 'rallar',
) {
    return {
        id,
        label,
        kind: 'direct',
        route: { workspace, tab },
        aliases,
    } as const;
}

function runnerSurface<
    const Id extends string,
    const Label extends string,
    const Tab extends string,
    const Aliases extends readonly string[],
>(id: Id, label: Label, tab: Tab, aliases: Aliases) {
    return {
        id,
        label,
        kind: 'advanced-legacy',
        route: { workspace: 'black-box-runner', tab },
        aliases,
    } as const;
}

function advancedChild<
    const Id extends string,
    const Label extends string,
    const Child extends string,
    const Aliases extends readonly string[],
>(id: Id, label: Label, advancedSurface: Child, aliases: Aliases) {
    return {
        id,
        label,
        kind: 'advanced-legacy',
        route: {
            workspace: 'black-box-runner',
            tab: 'advanced',
            advancedSurface,
        },
        aliases,
    } as const;
}

function normalize(value: string | null | undefined): string | undefined {
    const normalized = value?.trim().toLowerCase();
    return normalized || undefined;
}
