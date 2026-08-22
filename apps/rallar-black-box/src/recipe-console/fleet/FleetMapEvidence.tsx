import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import type { FleetMapLayerProjection, FleetMapModel } from './fleet-map-model.ts';
import { FleetLocationEvidence } from './FleetLocationEvidence.tsx';
import styles from './FleetMap.module.css';

export function FleetMapEvidence({
    model,
    onSelectAgent,
    onSelectRegion,
    selectedAgentId,
    selectedRegion
}: Readonly<{
    model: FleetMapModel;
    onSelectAgent(agentId: string, trigger: HTMLButtonElement): void;
    onSelectRegion(region: string | undefined, trigger: HTMLButtonElement): void;
    selectedAgentId?: string;
    selectedRegion?: string;
}>) {
    return (
        <div className={styles.evidence}>
            <Layer label="Live agents" layer={model.agentMarkers}>
                {model.agentMarkers.items.map((item) => (
                    <button
                        aria-pressed={item.agent.agentId === selectedAgentId}
                        data-map-agent-id={item.agent.agentId}
                        key={item.id}
                        onClick={(event) =>
                            onSelectAgent(
                                item.agent.agentId,
                                event.currentTarget
                            )}
                        type="button"
                    >
                        <ExactIdentifier value={item.agent.agentId} />
                        <span>
                            {item.agent.live?.state ?? 'Unknown'} · {item.agent.location
                                ? (
                                    <FleetLocationEvidence
                                        location={item.agent.location}
                                    />
                                )
                                : 'unresolved'}
                        </span>
                    </button>
                ))}
            </Layer>
            <Layer label="Historical regions" layer={model.regionMarkers}>
                {model.regionMarkers.items.map((item) => {
                    const selected = item.region.region === selectedRegion;
                    return (
                        <button
                            aria-pressed={selected}
                            data-map-region={item.region.region}
                            key={item.id}
                            onClick={(event) =>
                                onSelectRegion(
                                    selected ? undefined : item.region.region,
                                    event.currentTarget
                                )}
                            type="button"
                        >
                            <strong>
                                <bdi dir="auto">{item.region.region}</bdi>
                            </strong>
                            <span>
                                {item.region.provider
                                    ? <bdi dir="auto">{item.region.provider}</bdi>
                                    : 'Unknown'} · {item.region.failed} failed ·{' '}
                                <FleetLocationEvidence
                                    location={item.region.location}
                                />
                            </span>
                        </button>
                    );
                })}
            </Layer>
            <Layer
                emptyMessage="No explicit resolved route evidence is available in this bounded snapshot."
                label="Observed routes"
                layer={model.routePaths}
            >
                {model.routePaths.items.map((item) => (
                    <p key={item.id}>
                        <ExactIdentifier value={item.route.sourceAgentId} /> →{' '}
                        <ExactIdentifier value={item.route.targetAgentId} /> · {item.route.transport
                            ? <bdi dir="auto">{item.route.transport}</bdi>
                            : 'unknown transport'} · {item.route.eventCount} observations, {item.route.failedCount}{' '}
                        failed · source <FleetLocationEvidence location={item.route.source} /> · target{' '}
                        <FleetLocationEvidence location={item.route.target} />
                    </p>
                ))}
            </Layer>
            <Layer label="Failure locations" layer={model.failureMarkers}>
                {model.failureMarkers.items.map((item) => (
                    <button
                        aria-pressed={item.agent.agentId === selectedAgentId}
                        data-map-failure-agent-id={item.agent.agentId}
                        key={item.id}
                        onClick={(event) =>
                            onSelectAgent(
                                item.agent.agentId,
                                event.currentTarget
                            )}
                        type="button"
                    >
                        <ExactIdentifier value={item.agent.agentId} />
                        <span>
                            {item.agent.historical?.failedOutcomes ?? 0} failed outcomes · {item.agent.location
                                ? (
                                    <FleetLocationEvidence
                                        location={item.agent.location}
                                    />
                                )
                                : 'unresolved'}
                        </span>
                    </button>
                ))}
            </Layer>
            <section className={styles.provenance} aria-labelledby="fleet-map-provenance">
                <h3 id="fleet-map-provenance">Geographic provenance</h3>
                <p>{model.unresolved.routeEvidenceLabel}</p>
                <p>{model.unresolved.routeObservationCount} observations have unresolved endpoints.</p>
                <p>
                    {model.unresolved.agentIds.length} unresolved agents;{' '}
                    {model.unresolved.routeEndpointAgentIds.length}{' '}
                    unresolved route endpoint identities. Traverse the persistent ledger below.
                </p>
            </section>
        </div>
    );
}

function Layer<Item>({
    children,
    emptyMessage,
    label,
    layer
}: Readonly<{
    children: React.ReactNode;
    emptyMessage?: string;
    label: string;
    layer: FleetMapLayerProjection<Item>;
}>) {
    return (
        <section className={styles.layerEvidence} data-layer-enabled={layer.enabled}>
            <h3>{label}</h3>
            <p>{layer.renderedCount} rendered of {layer.candidateCount} candidates; {layer.omittedCount} omitted.</p>
            {layer.candidateCount === 0 && emptyMessage ? <p data-fleet-map-no-routes>{emptyMessage}</p> : null}
            <div>{children}</div>
        </section>
    );
}
