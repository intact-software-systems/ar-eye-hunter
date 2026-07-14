import { useEffect, useMemo, useRef, useState } from 'react';
import Sigma from 'sigma';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import {
    deriveRallarTopologyGraph,
    visibleTopologyCounts,
    type RallarTopologyFilter,
} from '../../../topology-graph.ts';
import { Metric } from '../../shared/Metric.tsx';

function topologyFilterLabel(filter: RallarTopologyFilter): string {
    return filter === 'all' ? 'All' : filter;
}

export function TopologyGraphPanel({
    state,
    active,
    onSelectCommand,
}: {
    state: RallarBlackBoxTestState;
    active: boolean;
    onSelectCommand(commandId: string): void;
}) {
    const [filter, setFilter] = useState<RallarTopologyFilter>('all');
    const [query, setQuery] = useState('');
    const [nodeLimit, setNodeLimit] = useState(18);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const topology = useMemo(() => deriveRallarTopologyGraph(state), [state]);
    const visibleCounts = useMemo(
        () => visibleTopologyCounts(topology.graph, filter),
        [filter, topology.graph],
    );
    const matchingNodes = useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();
        const rows: Array<
            Readonly<{
                id: string;
                label: string;
                kind: string;
                status: string;
                eventCount: number;
            }>
        > = [];
        topology.graph.forEachNode((id, attrs) => {
            if (filter !== 'all' && attrs.status !== filter) {
                return;
            }
            if (
                normalizedQuery.length > 0 &&
                !`${id} ${attrs.label} ${attrs.kind} ${attrs.status}`
                    .toLowerCase()
                    .includes(normalizedQuery)
            ) {
                return;
            }
            rows.push({
                id,
                label: attrs.label,
                kind: attrs.kind,
                status: attrs.status,
                eventCount: attrs.eventCount,
            });
        });
        return rows.sort(
            (left, right) =>
                left.kind.localeCompare(right.kind) ||
                left.label.localeCompare(right.label),
        );
    }, [filter, query, topology.graph]);
    const visibleNodes = useMemo(
        () => matchingNodes.slice(0, nodeLimit),
        [matchingNodes, nodeLimit],
    );
    const routeResults = useMemo(
        () =>
            state.commandHistory
                .filter(
                    (result) =>
                        result.kind === 'rtc.send' || result.kind === 'ws.send',
                )
                .slice(-8)
                .reverse(),
        [state.commandHistory],
    );
    const routeSummary = useMemo(() => {
        const routes = state.commandHistory.filter(
            (result) => result.kind === 'rtc.send' || result.kind === 'ws.send',
        );
        return {
            total: routes.length,
            failed: routes.filter((result) => !result.ok).length,
            rtc: routes.filter((result) => result.kind === 'rtc.send').length,
            ws: routes.filter((result) => result.kind === 'ws.send').length,
        };
    }, [state.commandHistory]);

    useEffect(() => {
        if (!active) {
            return;
        }

        const container = containerRef.current;
        if (!container) {
            return;
        }

        const renderer = new Sigma(topology.graph, container, {
            allowInvalidContainer: true,
            hideEdgesOnMove: false,
            hideLabelsOnMove: true,
            labelRenderedSizeThreshold: 8,
            nodeReducer: (_node, attrs) => ({
                ...attrs,
                hidden: filter !== 'all' && attrs.status !== filter,
                highlighted: attrs.status === 'failed',
            }),
            edgeReducer: (_edge, attrs) => ({
                ...attrs,
                hidden: filter !== 'all' && attrs.status !== filter,
            }),
        });

        return () => renderer.kill();
    }, [active, filter, topology.graph]);

    return (
        <section className="panel topology-panel">
            <div className="panel-heading">
                <h2>Topology</h2>
                <span>{visibleCounts.nodes} nodes</span>
            </div>
            <div
                className="segmented topology-filters"
                role="group"
                aria-label="Topology filter"
            >
                {(['all', 'active', 'degraded', 'failed'] as const).map(
                    (entry) => (
                        <button
                            type="button"
                            key={entry}
                            className={filter === entry ? 'selected' : ''}
                            onClick={() => setFilter(entry)}
                        >
                            {topologyFilterLabel(entry)}
                        </button>
                    ),
                )}
            </div>
            <div className="topology-search-grid">
                <label className="field compact-field">
                    <span>Search</span>
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="node, route, status"
                    />
                </label>
                <label className="field compact-field">
                    <span>Node Limit</span>
                    <select
                        value={nodeLimit}
                        onChange={(event) =>
                            setNodeLimit(Number(event.target.value))
                        }
                    >
                        {[18, 50, 100, 200].map((limit) => (
                            <option key={limit} value={limit}>
                                {limit}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <div className="topology-summary-grid">
                <Metric label="Edges" value={String(visibleCounts.edges)} />
                <Metric label="Rooms" value={String(topology.summary.rooms)} />
                <Metric
                    label="Sessions"
                    value={String(topology.summary.sessions)}
                />
                <Metric
                    label="Routes"
                    value={String(topology.summary.routes)}
                />
                <Metric
                    label="Degraded"
                    value={String(
                        topology.summary.degradedNodes +
                            topology.summary.degradedEdges,
                    )}
                    tone={
                        topology.summary.degradedNodes +
                            topology.summary.degradedEdges >
                        0
                            ? 'warn'
                            : 'good'
                    }
                />
                <Metric
                    label="Failed"
                    value={String(
                        topology.summary.failedNodes +
                            topology.summary.failedEdges,
                    )}
                    tone={
                        topology.summary.failedNodes +
                            topology.summary.failedEdges >
                        0
                            ? 'bad'
                            : 'good'
                    }
                />
                <Metric label="Route cmds" value={String(routeSummary.total)} />
                <Metric label="RTC routes" value={String(routeSummary.rtc)} />
                <Metric label="WS routes" value={String(routeSummary.ws)} />
                <Metric
                    label="Route failures"
                    value={String(routeSummary.failed)}
                    tone={routeSummary.failed > 0 ? 'bad' : 'good'}
                />
            </div>
            <div
                className="sigma-host"
                ref={containerRef}
                aria-label="Rallar topology graph"
            />
            <div className="topology-lists">
                <div className="topology-node-list">
                    <div className="section-heading">
                        <h3>Nodes</h3>
                        <span>
                            {visibleNodes.length} of {matchingNodes.length}
                        </span>
                    </div>
                    <div className="topology-list-body">
                        {visibleNodes.length === 0 && (
                            <div className="empty-state">No topology nodes</div>
                        )}
                        {visibleNodes.map((node) => (
                            <article
                                className="topology-node-row"
                                key={node.id}
                            >
                                <div>
                                    <strong>{node.label}</strong>
                                    <small>
                                        {node.kind} - {node.eventCount} events
                                    </small>
                                </div>
                                <span
                                    className={`pill ${node.status === 'failed' ? 'bad' : node.status === 'degraded' ? 'warn' : 'good'}`}
                                >
                                    {node.status}
                                </span>
                            </article>
                        ))}
                    </div>
                </div>
                <div className="topology-node-list">
                    <div className="section-heading">
                        <h3>Routes</h3>
                        <span>{routeResults.length} commands</span>
                    </div>
                    <div className="topology-list-body">
                        {routeResults.length === 0 && (
                            <div className="empty-state">No route commands</div>
                        )}
                        {routeResults.map((result, index) => (
                            <button
                                type="button"
                                className="topology-route-row"
                                key={`${result.commandId}-${index}`}
                                onClick={() =>
                                    onSelectCommand(result.commandId)
                                }
                            >
                                <span>{result.commandId}</span>
                                <small>{result.kind}</small>
                                <span
                                    className={`pill ${result.ok ? 'good' : 'bad'}`}
                                >
                                    {result.status}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
}
