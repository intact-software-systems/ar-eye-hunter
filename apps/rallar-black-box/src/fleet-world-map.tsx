import type {
    FleetWorldMapAgent,
    FleetWorldMapLayerId,
    FleetWorldMapLayerState,
    FleetWorldMapRegion,
    FleetWorldMapRoute,
    FleetWorldMapViewModel,
} from './world-map-model.ts';
import {
    FLEET_WORLD_MAP_LAYER_IDS,
} from './world-map-model.ts';
import {
    projectWorldCoordinate,
    WORLD_MAP_VIEWBOX,
    worldMapArcPath,
} from './world-map-projection.ts';

export type FleetWorldMapProps = Readonly<{
    model: FleetWorldMapViewModel;
    layers: FleetWorldMapLayerState;
    selectedAgentId?: string;
    onLayerChange: (layerId: FleetWorldMapLayerId, enabled: boolean) => void;
    onSelectAgent: (agentId: string) => void;
    onSelectRegion: (region: FleetWorldMapRegion) => void;
}>;

const LAYER_LABELS: Readonly<Record<FleetWorldMapLayerId, string>> = {
    'live-agents': 'Live agents',
    'historical-regions': 'Historical regions',
    failures: 'Failures',
    'observed-routes': 'Observed routes',
};

const LANDMASSES = [
    'M 108 176 L 170 116 L 256 124 L 298 186 L 268 246 L 188 274 L 126 238 Z',
    'M 276 132 L 354 104 L 432 132 L 444 202 L 378 246 L 300 220 Z',
    'M 490 136 L 566 108 L 666 144 L 708 218 L 650 266 L 540 244 L 474 198 Z',
    'M 564 254 L 626 280 L 654 362 L 616 438 L 552 392 L 532 306 Z',
    'M 712 202 L 806 170 L 892 216 L 876 290 L 788 308 L 716 262 Z',
    'M 792 336 L 884 350 L 918 406 L 854 440 L 780 408 Z',
] as const;

export function FleetWorldMap({
    model,
    layers,
    selectedAgentId,
    onLayerChange,
    onSelectAgent,
    onSelectRegion,
}: FleetWorldMapProps) {
    const visibleAgents = layers['live-agents']
        ? model.liveAgents.filter((agent) => agent.location)
        : [];
    const visibleRegions = layers['historical-regions']
        ? model.regions
        : [];
    const visibleRoutes = layers['observed-routes']
        ? model.routes
        : [];
    const failedAgents = visibleAgents.filter((agent) =>
        agent.state === 'failed' || agent.failureSignatureIds.length > 0
    );
    const selectedAgent = selectedAgentId
        ? model.agents.find((agent) => agent.agentId === selectedAgentId)
        : undefined;

    return (
        <section className="fleet-subpanel fleet-world-map-panel" aria-label="Fleet World Map">
            <div className="section-heading">
                <div>
                    <h3>Fleet World Map</h3>
                    <p>Live control agents, historical report regions, and observed routes.</p>
                </div>
                <span>{visibleAgents.length} mapped</span>
            </div>
            <div className="fleet-map-layer-row" aria-label="Fleet map layers">
                {FLEET_WORLD_MAP_LAYER_IDS.map((layerId) => (
                    <button
                        type="button"
                        key={layerId}
                        aria-pressed={layers[layerId]}
                        onClick={() => onLayerChange(layerId, !layers[layerId])}
                    >
                        {LAYER_LABELS[layerId]}
                    </button>
                ))}
            </div>
            <div className="fleet-map-grid">
                <svg
                    className="fleet-map-svg"
                    viewBox={`0 0 ${WORLD_MAP_VIEWBOX.width} ${WORLD_MAP_VIEWBOX.height}`}
                    role="img"
                    aria-label={`${visibleAgents.length} mapped fleet agents across ${model.regions.length} historical regions`}
                >
                    <rect className="fleet-map-ocean" width="1000" height="520" />
                    {gridLines()}
                    {LANDMASSES.map((path, index) => (
                        <path
                            className="fleet-map-land"
                            d={path}
                            key={`land-${index}`}
                        />
                    ))}
                    {visibleRegions.map((region) => (
                        <FleetRegionMarker
                            key={region.key}
                            region={region}
                            onSelectRegion={onSelectRegion}
                        />
                    ))}
                    {visibleRoutes.map((route) => (
                        <FleetRouteArc route={route} key={route.routeId} />
                    ))}
                    {layers.failures && failedAgents.map((agent) => (
                        <FleetFailureHalo agent={agent} key={`failure-${agent.agentId}`} />
                    ))}
                    {visibleAgents.map((agent) => (
                        <FleetAgentMarker
                            agent={agent}
                            selected={agent.agentId === selectedAgentId}
                            key={agent.agentId}
                            onSelectAgent={onSelectAgent}
                        />
                    ))}
                </svg>
                <aside className="fleet-map-detail">
                    <div className="fleet-map-stat-row">
                        <span>{model.summary.agents} agents</span>
                        <span>{model.summary.historicalRegions} regions</span>
                        <span>{model.summary.routes} routes</span>
                    </div>
                    {model.summary.unresolvedAgents > 0 && (
                        <div className="fleet-map-warning" role="status">
                            {model.summary.unresolvedAgents} unresolved locations
                        </div>
                    )}
                    {layers['observed-routes'] && model.routes.length === 0 && (
                        <div className="fleet-map-empty">
                            No observed routes with map-ready endpoints.
                        </div>
                    )}
                    {selectedAgent ? (
                        <FleetSelectedAgent agent={selectedAgent} />
                    ) : (
                        <FleetMapRegionSummary regions={model.regions} />
                    )}
                </aside>
            </div>
        </section>
    );
}

function FleetAgentMarker({
    agent,
    selected,
    onSelectAgent,
}: Readonly<{
    agent: FleetWorldMapAgent;
    selected: boolean;
    onSelectAgent: (agentId: string) => void;
}>) {
    if (!agent.location) {
        return null;
    }
    const point = projectWorldCoordinate(agent.location);
    return (
        <g
            className={`fleet-map-marker ${markerTone(agent)} ${selected ? 'selected' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={`${agent.agentId} ${agent.state} ${agent.location.label}`}
            transform={`translate(${point.x} ${point.y})`}
            onClick={() => onSelectAgent(agent.agentId)}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectAgent(agent.agentId);
                }
            }}
        >
            <circle r={selected ? 8 : 5} />
            <text x="9" y="4">{shortAgentLabel(agent.agentId)}</text>
        </g>
    );
}

function FleetFailureHalo({
    agent,
}: Readonly<{ agent: FleetWorldMapAgent }>) {
    if (!agent.location) {
        return null;
    }
    const point = projectWorldCoordinate(agent.location);
    return (
        <circle
            className="fleet-map-failure-halo"
            cx={point.x}
            cy={point.y}
            r={12 + Math.min(8, agent.failureSignatureIds.length * 2)}
        />
    );
}

function FleetRegionMarker({
    region,
    onSelectRegion,
}: Readonly<{
    region: FleetWorldMapRegion;
    onSelectRegion: (region: FleetWorldMapRegion) => void;
}>) {
    const point = projectWorldCoordinate(region.location);
    const radius = 10 + Math.min(18, region.agentCount * 2);
    return (
        <g
            className={`fleet-map-region-marker ${region.failed > 0 ? 'has-failures' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={`${region.region} ${region.agentCount} agents`}
            transform={`translate(${point.x} ${point.y})`}
            onClick={() => onSelectRegion(region)}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectRegion(region);
                }
            }}
        >
            <circle r={radius} />
            <text x={radius + 5} y="4">{region.region}</text>
        </g>
    );
}

function FleetRouteArc({
    route,
}: Readonly<{ route: FleetWorldMapRoute }>) {
    const source = projectWorldCoordinate(route.source);
    const target = projectWorldCoordinate(route.target);
    return (
        <path
            className={`fleet-map-route ${route.failedCount > 0 ? 'has-failures' : ''}`}
            d={worldMapArcPath(source, target)}
        />
    );
}

function FleetSelectedAgent({
    agent,
}: Readonly<{ agent: FleetWorldMapAgent }>) {
    return (
        <dl className="fleet-map-detail-list">
            <div>
                <dt>Agent</dt>
                <dd>{agent.agentId}</dd>
            </div>
            <div>
                <dt>Location</dt>
                <dd>{agent.location?.label ?? 'unresolved'}</dd>
            </div>
            <div>
                <dt>Status</dt>
                <dd>{agent.state}</dd>
            </div>
            <div>
                <dt>Runs</dt>
                <dd>{agent.runIds.length || '-'}</dd>
            </div>
        </dl>
    );
}

function FleetMapRegionSummary({
    regions,
}: Readonly<{ regions: readonly FleetWorldMapRegion[] }>) {
    const topRegions = regions.slice(0, 4);
    return (
        <div className="fleet-map-region-list">
            {topRegions.map((region) => (
                <div className="fleet-map-region-row" key={region.key}>
                    <strong>{region.region}</strong>
                    <span>{Math.round(region.passRate * 100)}%</span>
                    <small>{region.agentCount} agents</small>
                </div>
            ))}
            {topRegions.length === 0 && (
                <div className="fleet-map-empty">No historical regions mapped.</div>
            )}
        </div>
    );
}

function gridLines() {
    const lines = [];
    for (let longitude = -120; longitude <= 120; longitude += 60) {
        const x = ((longitude + 180) / 360) * WORLD_MAP_VIEWBOX.width;
        lines.push(
            <line
                className="fleet-map-grid-line"
                x1={x}
                x2={x}
                y1="0"
                y2={WORLD_MAP_VIEWBOX.height}
                key={`lon-${longitude}`}
            />,
        );
    }
    for (let latitude = -60; latitude <= 60; latitude += 30) {
        const y = ((90 - latitude) / 180) * WORLD_MAP_VIEWBOX.height;
        lines.push(
            <line
                className="fleet-map-grid-line"
                x1="0"
                x2={WORLD_MAP_VIEWBOX.width}
                y1={y}
                y2={y}
                key={`lat-${latitude}`}
            />,
        );
    }
    return lines;
}

function markerTone(agent: FleetWorldMapAgent): string {
    if (agent.state === 'failed' || agent.failureSignatureIds.length > 0) {
        return 'bad';
    }
    if (agent.state === 'stale' || agent.state === 'missing') {
        return 'warn';
    }
    if (agent.connected || agent.state === 'passed') {
        return 'good';
    }
    return 'muted';
}

function shortAgentLabel(agentId: string): string {
    return agentId.length > 10 ? agentId.slice(-8) : agentId;
}
