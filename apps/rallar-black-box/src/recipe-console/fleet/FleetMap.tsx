import { worldMapArcPath, WORLD_MAP_VIEWBOX } from
    '../../world-map-projection.ts';
import {
    RECIPE_CONSOLE_FLEET_MAP_LAYERS,
    type RecipeConsoleFleetMapLayer,
} from '../routing/url-state-contract.ts';
import { FleetMapEvidence } from './FleetMapEvidence.tsx';
import type { FleetMapModel } from './fleet-map-model.ts';
import styles from './FleetMap.module.css';

const LAYER_LABELS: Readonly<Record<RecipeConsoleFleetMapLayer, string>> = {
    'live-agents': 'Live agents',
    'historical-regions': 'Historical regions',
    failures: 'Failures',
    'observed-routes': 'Observed routes',
};

export function FleetMap({
    model,
    onSelectAgent,
    onSelectRegion,
    onToggleLayer,
    selectedAgentId,
    selectedRegion,
}: Readonly<{
    model: FleetMapModel;
    onSelectAgent(agentId: string, trigger: HTMLButtonElement): void;
    onSelectRegion(region: string | undefined, trigger: HTMLButtonElement): void;
    onToggleLayer(layer: RecipeConsoleFleetMapLayer, enabled: boolean): void;
    selectedAgentId?: string;
    selectedRegion?: string;
}>) {
    const enabled = new Set(model.enabledLayers);
    return (
        <section aria-labelledby="fleet-map-heading" className={styles.root}>
            <header className={styles.heading}>
                <div>
                    <span>Secondary geographic evidence</span>
                    <h2 id="fleet-map-heading">Fleet evidence map</h2>
                </div>
                <div aria-label="Fleet map layers" className={styles.layers}>
                    {RECIPE_CONSOLE_FLEET_MAP_LAYERS.map(layer => (
                        <button
                            aria-pressed={enabled.has(layer)}
                            data-fleet-map-layer={layer}
                            key={layer}
                            onClick={() => onToggleLayer(layer, !enabled.has(layer))}
                            type="button"
                        >{LAYER_LABELS[layer]}</button>
                    ))}
                </div>
            </header>
            <div className={styles.mapFrame}>
                <svg
                    aria-hidden="true"
                    className={styles.map}
                    preserveAspectRatio="xMidYMid meet"
                    viewBox={`0 0 ${WORLD_MAP_VIEWBOX.width} ${WORLD_MAP_VIEWBOX.height}`}
                >
                    <rect className={styles.ocean} height="520" width="1000" />
                    <path className={styles.graticule} d="M 0 130 H 1000 M 0 260 H 1000 M 0 390 H 1000 M 250 0 V 520 M 500 0 V 520 M 750 0 V 520" />
                    <path className={styles.land} d="M76 116 147 72 247 89 288 145 251 197 196 194 171 248 118 230 93 174ZM338 87 403 62 475 86 504 137 478 182 424 176 393 226 354 191 321 139ZM421 238 478 222 511 278 494 365 455 438 415 376 398 292ZM540 83 632 55 741 79 824 126 785 176 702 169 670 219 600 198 551 151ZM760 251 844 235 908 274 888 331 824 349 778 314Z" />
                    {model.routePaths.items.map(item => (
                        <path
                            className={styles.route}
                            d={worldMapArcPath(item.sourcePoint, item.targetPoint)}
                            data-fleet-map-route={item.id}
                            data-severity={item.severity}
                            key={item.id}
                        />
                    ))}
                    {model.regionMarkers.items.map(item => (
                        <circle
                            className={styles.region}
                            cx={item.point.x}
                            cy={item.point.y}
                            data-fleet-map-region={item.id}
                            data-selected={item.selected}
                            data-severity={item.severity}
                            key={item.id}
                            r={item.selected ? 16 : 12}
                        />
                    ))}
                    {model.agentMarkers.items.map(item => (
                        <circle
                            className={styles.agent}
                            cx={item.point.x}
                            cy={item.point.y}
                            data-fleet-map-agent={item.id}
                            data-selected={item.selected}
                            data-severity={item.severity}
                            key={item.id}
                            r={item.selected ? 8 : 6}
                        />
                    ))}
                    {model.failureMarkers.items.map(item => (
                        <path
                            className={styles.failure}
                            d={`M ${item.point.x - 7} ${item.point.y - 7} L ${item.point.x + 7} ${item.point.y + 7} M ${item.point.x + 7} ${item.point.y - 7} L ${item.point.x - 7} ${item.point.y + 7}`}
                            data-fleet-map-failure={item.id}
                            data-selected={item.selected}
                            data-severity={item.severity}
                            key={item.id}
                        />
                    ))}
                    <text className={styles.mapSummary} x="20" y="30">
                        {model.agentMarkers.renderedCount} agents ·{' '}
                        {model.regionMarkers.renderedCount} regions ·{' '}
                        {model.routePaths.renderedCount} routes ·{' '}
                        {model.failureMarkers.renderedCount} failure marks
                    </text>
                </svg>
            </div>
            <FleetMapEvidence
                model={model}
                onSelectAgent={onSelectAgent}
                onSelectRegion={onSelectRegion}
                selectedAgentId={selectedAgentId}
                selectedRegion={selectedRegion}
            />
        </section>
    );
}
