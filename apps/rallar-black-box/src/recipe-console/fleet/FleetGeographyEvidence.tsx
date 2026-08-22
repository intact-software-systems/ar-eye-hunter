import type { FleetGeographyRoute } from '@shared-test/rallar-bb-test/fleet-geography.ts';
import type { ReactNode } from 'react';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import type { FleetMapAgentMarker, FleetMapFailureMarker, FleetMapRegionMarker } from './fleet-map-model.ts';
import styles from './FleetGeographyEvidence.module.css';
import { FleetLocationEvidence } from './FleetLocationEvidence.tsx';
import { FleetWindowControls } from './FleetWindowControls.tsx';
import type { FleetWindowController } from './use-fleet-window.ts';

export function FleetGeographyEvidence({
    agentMarkers,
    agentWindow,
    failureMarkers,
    failureWindow,
    regionMarkers,
    regionWindow,
    routeEvidenceLabel,
    routes,
    routeWindow,
    unresolvedAgentIds,
    unresolvedAgentWindow,
    unresolvedEndpointAgentIds,
    unresolvedEndpointObservationCount,
    unresolvedEndpointWindow
}: Readonly<{
    agentMarkers: readonly FleetMapAgentMarker[];
    agentWindow: FleetWindowController;
    failureMarkers: readonly FleetMapFailureMarker[];
    failureWindow: FleetWindowController;
    regionMarkers: readonly FleetMapRegionMarker[];
    regionWindow: FleetWindowController;
    routeEvidenceLabel: string;
    routes: readonly FleetGeographyRoute[];
    routeWindow: FleetWindowController;
    unresolvedAgentIds: readonly string[];
    unresolvedAgentWindow: FleetWindowController;
    unresolvedEndpointAgentIds: readonly string[];
    unresolvedEndpointObservationCount: number;
    unresolvedEndpointWindow: FleetWindowController;
}>) {
    const visibleAgentMarkers = windowItems(agentMarkers, agentWindow);
    const visibleRegionMarkers = windowItems(regionMarkers, regionWindow);
    const visibleFailureMarkers = windowItems(failureMarkers, failureWindow);
    const visibleRoutes = windowItems(routes, routeWindow);
    const visibleAgents = windowItems(unresolvedAgentIds, unresolvedAgentWindow);
    const visibleEndpoints = windowItems(
        unresolvedEndpointAgentIds,
        unresolvedEndpointWindow
    );
    return (
        <section aria-labelledby="fleet-geography-ledger" className={styles.root}>
            <header>
                <span>Persistent map-equivalent evidence</span>
                <h2 id="fleet-geography-ledger">Geographic evidence ledger</h2>
                <p>{routeEvidenceLabel}</p>
            </header>
            <div className={styles.threeColumn}>
                <EvidenceWindow
                    contentId="fleet-resolved-agent-locations"
                    itemLabel="resolved live agent locations"
                    label="Fleet resolved live agent locations"
                    window={agentWindow}
                >
                    <ol className={styles.routes}>
                        {visibleAgentMarkers.map((marker) => (
                            <li
                                data-fleet-resolved-agent-location={marker.agent.agentId}
                                key={marker.id}
                            >
                                <ExactIdentifier value={marker.agent.agentId} />
                                <FleetLocationEvidence location={marker.agent.location!} />
                            </li>
                        ))}
                    </ol>
                </EvidenceWindow>
                <EvidenceWindow
                    contentId="fleet-resolved-region-locations"
                    itemLabel="resolved region locations"
                    label="Fleet resolved region locations"
                    window={regionWindow}
                >
                    <ol className={styles.routes}>
                        {visibleRegionMarkers.map((marker) => (
                            <li
                                data-fleet-resolved-region-location={marker.region.key}
                                key={marker.id}
                            >
                                <bdi dir="auto">{marker.region.region}</bdi>
                                {marker.region.provider
                                    ? <bdi dir="auto">{marker.region.provider}</bdi>
                                    : <span>Unknown provider</span>}
                                <FleetLocationEvidence location={marker.region.location} />
                            </li>
                        ))}
                    </ol>
                </EvidenceWindow>
                <EvidenceWindow
                    contentId="fleet-resolved-failure-locations"
                    itemLabel="resolved failure locations"
                    label="Fleet resolved failure locations"
                    window={failureWindow}
                >
                    <ol className={styles.routes}>
                        {visibleFailureMarkers.map((marker) => (
                            <li
                                data-fleet-resolved-failure-location={marker.agent.agentId}
                                key={marker.id}
                            >
                                <ExactIdentifier value={marker.agent.agentId} />
                                <span>{marker.agent.historical?.failedOutcomes ?? 0} failed outcomes</span>
                                <FleetLocationEvidence location={marker.agent.location!} />
                            </li>
                        ))}
                    </ol>
                </EvidenceWindow>
            </div>
            <EvidenceWindow
                contentId="fleet-route-evidence"
                itemLabel="observed routes"
                label="Fleet observed routes"
                window={routeWindow}
            >
                <ol className={styles.routes}>
                    {visibleRoutes.map((route) => (
                        <li
                            data-fleet-route-evidence={route.routeId}
                            key={route.routeId}
                        >
                            <ExactIdentifier value={route.sourceAgentId} />
                            <span aria-hidden="true">→</span>
                            <ExactIdentifier value={route.targetAgentId} />
                            <span>
                                {route.transport
                                    ? <bdi dir="auto">{route.transport}</bdi>
                                    : 'unknown transport'} · {route.eventCount.toLocaleString('en-US')} observations ·
                                {' '}
                                {route.failedCount.toLocaleString('en-US')} failed · source{' '}
                                <FleetLocationEvidence location={route.source} /> · target{' '}
                                <FleetLocationEvidence location={route.target} />
                            </span>
                        </li>
                    ))}
                </ol>
            </EvidenceWindow>
            <div className={styles.twoColumn}>
                <EvidenceWindow
                    contentId="fleet-unresolved-agents"
                    itemLabel="unresolved agents"
                    label="Fleet unresolved agents"
                    window={unresolvedAgentWindow}
                >
                    <IdentifierList
                        attribute="data-fleet-unresolved-agent"
                        values={visibleAgents}
                    />
                </EvidenceWindow>
                <EvidenceWindow
                    contentId="fleet-unresolved-route-endpoints"
                    itemLabel="unresolved route endpoints"
                    label="Fleet unresolved route endpoints"
                    window={unresolvedEndpointWindow}
                >
                    <p>
                        {unresolvedEndpointObservationCount.toLocaleString('en-US')} unresolved endpoint observations.
                    </p>
                    <IdentifierList
                        attribute="data-fleet-unresolved-endpoint"
                        values={visibleEndpoints}
                    />
                </EvidenceWindow>
            </div>
        </section>
    );
}

function EvidenceWindow({
    children,
    contentId,
    itemLabel,
    label,
    window
}: Readonly<{
    children: ReactNode;
    contentId: string;
    itemLabel: string;
    label: string;
    window: FleetWindowController;
}>) {
    return (
        <div className={styles.window}>
            <FleetWindowControls
                contentId={contentId}
                itemLabel={itemLabel}
                label={label}
                window={window}
            />
            <div id={contentId} {...window.contentFocusProps}>{children}</div>
        </div>
    );
}

function IdentifierList({
    attribute,
    values
}: Readonly<{
    attribute:
        | 'data-fleet-unresolved-agent'
        | 'data-fleet-unresolved-endpoint';
    values: readonly string[];
}>) {
    return values.length === 0
        ? <p className={styles.empty}>None.</p>
        : (
            <ul className={styles.identifiers}>
                {values.map((value) => (
                    <li {...{ [attribute]: value }} key={value}>
                        <ExactIdentifier value={value} />
                    </li>
                ))}
            </ul>
        );
}

function windowItems<Item>(
    items: readonly Item[],
    window: FleetWindowController
): readonly Item[] {
    return items.slice(
        window.model.startIndex,
        window.model.endIndexExclusive
    );
}
