import type {
    ControlFleetReportFilter,
    ControlFleetRunReport,
} from '../../../control-run-manager.ts';
import {
    DEFAULT_FLEET_WORLD_MAP_LAYER_STATE,
    FLEET_WORLD_MAP_LAYER_IDS,
    type FleetWorldMapLayerId,
    type FleetWorldMapLayerState,
} from '../../../world-map-model.ts';
import type {
    FleetFilterState,
    FleetLabelOverride,
} from './fleet-types.ts';

const DEFAULT_FLEET_FILTERS: FleetFilterState = {
    region: '',
    provider: '',
    recipeId: '',
    groupId: '',
    state: '',
    window: '24h',
};

export function readFleetFiltersFromUrl(): FleetFilterState {
    if (typeof window === 'undefined') {
        return DEFAULT_FLEET_FILTERS;
    }
    const params = new URL(window.location.href).searchParams;
    return {
        region: params.get('region') ?? '',
        provider: params.get('provider') ?? '',
        recipeId: params.get('recipeId') ?? '',
        groupId: params.get('groupId') ?? '',
        state: params.get('state') ?? '',
        window: parseFleetWindow(
            params.get('window') ?? params.get('timeWindow'),
        ),
    };
}

export function writeFleetFiltersToUrl(filters: FleetFilterState): void {
    if (typeof window === 'undefined') {
        return;
    }
    const url = new URL(window.location.href);
    writeFleetFiltersToSearchParams(url.searchParams, filters);
    window.history.replaceState(window.history.state, '', url.toString());
}

export function writeFleetFiltersToSearchParams(
    params: URLSearchParams,
    filters: FleetFilterState,
): void {
    const entries: ReadonlyArray<[keyof FleetFilterState, string]> = [
        ['region', filters.region],
        ['provider', filters.provider],
        ['recipeId', filters.recipeId],
        ['groupId', filters.groupId],
        ['state', filters.state],
        ['window', filters.window],
    ];
    entries.forEach(([key, value]) => {
        if (value && value !== DEFAULT_FLEET_FILTERS[key]) {
            params.set(key, value);
        } else {
            params.delete(key);
        }
    });
}

export function readFleetWorldMapLayersFromUrl(): FleetWorldMapLayerState {
    if (typeof window === 'undefined') {
        return DEFAULT_FLEET_WORLD_MAP_LAYER_STATE;
    }
    const params = new URL(window.location.href).searchParams;
    return parseFleetWorldMapLayers(params.get('fleetMapLayers'));
}

export function writeFleetWorldMapLayersToUrl(
    layers: FleetWorldMapLayerState,
): void {
    if (typeof window === 'undefined') {
        return;
    }
    const url = new URL(window.location.href);
    writeFleetWorldMapLayersToSearchParams(url.searchParams, layers);
    window.history.replaceState(window.history.state, '', url.toString());
}

export function writeFleetWorldMapLayersToSearchParams(
    params: URLSearchParams,
    layers: FleetWorldMapLayerState,
): void {
    if (fleetWorldMapLayersEqual(layers, DEFAULT_FLEET_WORLD_MAP_LAYER_STATE)) {
        params.delete('fleetMapLayers');
        return;
    }
    const enabled = FLEET_WORLD_MAP_LAYER_IDS.filter((layerId) => layers[layerId]);
    if (enabled.length === 0) {
        params.set('fleetMapLayers', 'none');
    } else {
        params.set('fleetMapLayers', enabled.join(','));
    }
}

export function buildFleetShareUrl(
    currentHref: string,
    filters: FleetFilterState,
    layers: FleetWorldMapLayerState,
): string {
    const url = new URL(currentHref);
    url.searchParams.set('mode', 'black-box-runner');
    url.searchParams.set('tab', 'fleet');
    writeFleetFiltersToSearchParams(url.searchParams, filters);
    writeFleetWorldMapLayersToSearchParams(url.searchParams, layers);
    return url.toString();
}

function parseFleetWorldMapLayers(
    value: string | null,
): FleetWorldMapLayerState {
    if (!value) {
        return DEFAULT_FLEET_WORLD_MAP_LAYER_STATE;
    }
    const enabled = new Set(
        value.split(',')
            .map((entry) => entry.trim())
            .filter((entry): entry is FleetWorldMapLayerId =>
                FLEET_WORLD_MAP_LAYER_IDS.includes(entry as FleetWorldMapLayerId)
            ),
    );
    return {
        'live-agents': enabled.has('live-agents'),
        'historical-regions': enabled.has('historical-regions'),
        failures: enabled.has('failures'),
        'observed-routes': enabled.has('observed-routes'),
    };
}

function fleetWorldMapLayersEqual(
    left: FleetWorldMapLayerState,
    right: FleetWorldMapLayerState,
): boolean {
    return FLEET_WORLD_MAP_LAYER_IDS.every((layerId) => left[layerId] === right[layerId]);
}

function parseFleetWindow(
    value: string | null | undefined,
): FleetFilterState['window'] {
    return value === '1h' || value === '24h' || value === '7d' ||
            value === 'all'
        ? value
        : DEFAULT_FLEET_FILTERS.window;
}

export function fleetReportFilterFromUi(
    filters: FleetFilterState,
): ControlFleetReportFilter {
    const filter: {
        region?: string;
        provider?: string;
        recipeId?: string;
        groupId?: string;
        state?: string;
        fromEpochMs?: number;
        toEpochMs?: number;
    } = {
        region: filters.region.trim() || undefined,
        provider: filters.provider.trim() || undefined,
        recipeId: filters.recipeId.trim() || undefined,
        groupId: filters.groupId.trim() || undefined,
        state: filters.state.trim() || undefined,
    };
    const now = Date.now();
    if (filters.window === '1h') {
        filter.fromEpochMs = now - 60 * 60 * 1000;
    } else if (filters.window === '24h') {
        filter.fromEpochMs = now - 24 * 60 * 60 * 1000;
    } else if (filters.window === '7d') {
        filter.fromEpochMs = now - 7 * 24 * 60 * 60 * 1000;
    }
    return filter;
}

export function parseFleetLabelOverrides(text: string): Readonly<{
    value: Readonly<Record<string, FleetLabelOverride>>;
    error?: string;
}> {
    const trimmed = text.trim();
    if (!trimmed) {
        return { value: {} };
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isFleetRecord(parsed)) {
            return {
                value: {},
                error: 'Overrides must be an object keyed by agent id.',
            };
        }
        const overrides: Record<string, FleetLabelOverride> = {};
        Object.entries(parsed).forEach(([agentId, value]) => {
            if (!isFleetRecord(value)) {
                return;
            }
            const label: Record<string, string | readonly string[] | undefined> =
                {};
            [
                'region',
                'provider',
                'datacenter',
                'hostId',
                'agentPoolId',
                'deploymentId',
                'browserName',
                'browserVersion',
                'os',
            ].forEach((key) => {
                const raw = value[key];
                if (typeof raw === 'string' && raw.trim().length > 0) {
                    label[key] = raw.trim();
                }
            });
            if (Array.isArray(value.tags)) {
                label.tags = value.tags
                    .filter((tag): tag is string => typeof tag === 'string')
                    .map((tag) => tag.trim())
                    .filter(Boolean);
            }
            if (Object.keys(label).length > 0) {
                overrides[agentId] = label;
            }
        });
        return { value: overrides };
    } catch (caught) {
        return {
            value: {},
            error: caught instanceof Error ? caught.message : String(caught),
        };
    }
}

function isFleetRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function applyFleetLabelOverrides(
    reports: readonly ControlFleetRunReport[],
    overrides: Readonly<Record<string, FleetLabelOverride>>,
): readonly ControlFleetRunReport[] {
    if (Object.keys(overrides).length === 0) {
        return reports;
    }
    return reports.map((report) => ({
        ...report,
        agents: report.agents.map((agent) => {
            const override = overrides[agent.agentId];
            return override
                ? {
                    ...agent,
                    label: {
                        ...agent.label,
                        ...override,
                        tags: override.tags ?? agent.label.tags,
                    },
                }
                : agent;
        }),
    }));
}
