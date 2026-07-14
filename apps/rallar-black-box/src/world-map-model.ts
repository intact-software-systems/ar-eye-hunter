import type {
    ControlAgentBoardRow,
} from './control-agent-board.ts';
import type {
    ControlRunSnapshot,
} from './control-run-manager.ts';
import type {
    ControlFleetAgentLabel,
    ControlFleetAgentRunOutcome,
    ControlFleetFailureSignature,
    ControlFleetRunReport,
} from '@shared-test/rallar-bb-test/fleet-report.ts';
import { fleetGeographyRouteEvidenceFromControlRun } from
    '@shared-test/rallar-bb-test/fleet-geography.ts';
import {
    resolveFleetWorldMapLocation,
    type FleetWorldMapLocation,
} from './world-map-geo-fixtures.ts';

export const FLEET_WORLD_MAP_LAYER_IDS = [
    'live-agents',
    'historical-regions',
    'failures',
    'observed-routes',
] as const;

export type FleetWorldMapLayerId = typeof FLEET_WORLD_MAP_LAYER_IDS[number];

export type FleetWorldMapLayerState = Readonly<Record<FleetWorldMapLayerId, boolean>>;

export const DEFAULT_FLEET_WORLD_MAP_LAYER_STATE: FleetWorldMapLayerState = {
    'live-agents': true,
    'historical-regions': true,
    failures: true,
    'observed-routes': true,
};

export type FleetWorldMapAgentState =
    | 'connected'
    | 'offline'
    | 'stale'
    | 'passed'
    | 'failed'
    | 'missing'
    | 'running'
    | 'unknown';

export type FleetWorldMapAgent = Readonly<{
    agentId: string;
    location?: FleetWorldMapLocation;
    state: FleetWorldMapAgentState;
    connected: boolean;
    synthetic: boolean;
    region?: string;
    provider?: string;
    datacenter?: string;
    lastSeenAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    runIds: readonly string[];
    failureSignatureIds: readonly string[];
}>;

export type FleetWorldMapRegion = Readonly<{
    region: string;
    provider?: string;
    key: string;
    location: FleetWorldMapLocation;
    agentCount: number;
    passed: number;
    failed: number;
    missing: number;
    stale: number;
    passRate: number;
    dominantFailureSignatureId?: string;
    latestRunId?: string;
}>;

export type FleetWorldMapRouteEvidence = Readonly<{
    sourceAgentId: string;
    targetAgentId: string;
    atEpochMs?: number;
    transport?: string;
    failed?: boolean;
}>;

export type FleetWorldMapRoute = Readonly<{
    routeId: string;
    sourceAgentId: string;
    targetAgentId: string;
    source: FleetWorldMapLocation;
    target: FleetWorldMapLocation;
    kind: 'observed-route';
    transport?: string;
    eventCount: number;
    failedCount: number;
    lastSeenAtEpochMs?: number;
}>;

export type FleetWorldMapViewModel = Readonly<{
    agents: readonly FleetWorldMapAgent[];
    liveAgents: readonly FleetWorldMapAgent[];
    historicalAgents: readonly FleetWorldMapAgent[];
    regions: readonly FleetWorldMapRegion[];
    routes: readonly FleetWorldMapRoute[];
    unresolvedAgentIds: readonly string[];
    summary: Readonly<{
        agents: number;
        liveAgents: number;
        historicalRegions: number;
        unresolvedAgents: number;
        routes: number;
        failedAgents: number;
    }>;
}>;

export type DeriveFleetWorldMapModelInput = Readonly<{
    liveAgents?: readonly ControlAgentBoardRow[];
    reports?: readonly ControlFleetRunReport[];
    selectedReportId?: string;
    routeEvidence?: readonly FleetWorldMapRouteEvidence[];
}>;

type MutableMapAgent = {
    agentId: string;
    location?: FleetWorldMapLocation;
    state: FleetWorldMapAgentState;
    connected: boolean;
    synthetic: boolean;
    region?: string;
    provider?: string;
    datacenter?: string;
    lastSeenAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    runIds: Set<string>;
    failureSignatureIds: Set<string>;
};

export function deriveFleetWorldMapModel(
    input: DeriveFleetWorldMapModelInput,
): FleetWorldMapViewModel {
    const agents = new Map<string, MutableMapAgent>();
    const liveAgents = new Map<string, MutableMapAgent>();
    const historicalAgents = new Map<string, MutableMapAgent>();
    const reports = input.reports ?? [];

    for (const report of reports) {
        for (const outcome of report.agents) {
            upsertAgent(agents, agentFromOutcome(outcome, report));
            upsertAgent(historicalAgents, agentFromOutcome(outcome, report));
        }
    }

    for (const row of input.liveAgents ?? []) {
        upsertAgent(agents, agentFromLiveRow(row));
        upsertAgent(liveAgents, agentFromLiveRow(row));
    }

    const agentList = sortedFrozenAgents(agents);
    const liveAgentList = sortedFrozenAgents(liveAgents);
    const historicalAgentList = sortedFrozenAgents(historicalAgents);
    const unresolvedAgentIds = agentList
        .filter((agent) => !agent.location)
        .map((agent) => agent.agentId);
    const routes = deriveRoutes(input.routeEvidence ?? [], agents);
    const regions = deriveRegions(reports);

    return {
        agents: agentList,
        liveAgents: liveAgentList,
        historicalAgents: historicalAgentList,
        regions,
        routes,
        unresolvedAgentIds,
        summary: {
            agents: agentList.length,
            liveAgents: liveAgentList.length,
            historicalRegions: regions.length,
            unresolvedAgents: unresolvedAgentIds.length,
            routes: routes.length,
            failedAgents: agentList.filter((agent) =>
                agent.state === 'failed' ||
                agent.failureSignatureIds.length > 0
            ).length,
        },
    };
}

function sortedFrozenAgents(
    agents: ReadonlyMap<string, MutableMapAgent>,
): readonly FleetWorldMapAgent[] {
    return [...agents.values()]
        .map(freezeAgent)
        .sort((left, right) => left.agentId.localeCompare(right.agentId));
}

export function routeEvidenceFromControlRun(
    run: ControlRunSnapshot | undefined,
): readonly FleetWorldMapRouteEvidence[] {
    return fleetGeographyRouteEvidenceFromControlRun(run, {
        observationOrder: 'source',
    }).observations.map(observation => ({
        sourceAgentId: observation.sourceAgentId,
        targetAgentId: observation.targetAgentId,
        atEpochMs: observation.atEpochMs,
        transport: observation.transport,
        failed: observation.failed,
    }));
}

function agentFromOutcome(
    outcome: ControlFleetAgentRunOutcome,
    report: ControlFleetRunReport,
): MutableMapAgent {
    return {
        agentId: outcome.agentId,
        location: locationFromLabel(outcome.label),
        state: stateFromOutcome(outcome),
        connected: false,
        synthetic: false,
        region: outcome.label.region,
        provider: outcome.label.provider,
        datacenter: outcome.label.datacenter,
        lastHeartbeatAtEpochMs: outcome.lastHeartbeatAtEpochMs,
        runIds: new Set([report.distributedRunId]),
        failureSignatureIds: new Set(outcome.failureSignatureIds),
    };
}

function agentFromLiveRow(row: ControlAgentBoardRow): MutableMapAgent {
    const identity = row.identity;
    return {
        agentId: row.agentId,
        location: resolveFleetWorldMapLocation({
            location: identity?.location,
            region: row.region ?? identity?.region,
            provider: row.provider ?? identity?.provider,
            datacenter: row.datacenter ?? identity?.datacenter,
        }),
        state: stateFromLiveRow(row),
        connected: row.connected,
        synthetic: row.synthetic,
        region: row.region ?? identity?.region,
        provider: row.provider ?? identity?.provider,
        datacenter: row.datacenter ?? identity?.datacenter,
        lastSeenAtEpochMs: row.lastSeenAtEpochMs,
        lastHeartbeatAtEpochMs: row.lastHeartbeatAtEpochMs,
        runIds: new Set(row.activeRuns.map((run) => run.distributedRunId)),
        failureSignatureIds: new Set(),
    };
}

function upsertAgent(
    agents: Map<string, MutableMapAgent>,
    next: MutableMapAgent,
): void {
    const current = agents.get(next.agentId);
    if (!current) {
        agents.set(next.agentId, next);
        return;
    }

    current.location = preferredLocation(current.location, next.location);
    current.state = preferredState(current.state, next.state);
    current.connected = current.connected || next.connected;
    current.synthetic = current.synthetic && next.synthetic;
    current.region = current.region ?? next.region;
    current.provider = current.provider ?? next.provider;
    current.datacenter = current.datacenter ?? next.datacenter;
    current.lastSeenAtEpochMs = maxDefined(current.lastSeenAtEpochMs, next.lastSeenAtEpochMs);
    current.lastHeartbeatAtEpochMs = maxDefined(
        current.lastHeartbeatAtEpochMs,
        next.lastHeartbeatAtEpochMs,
    );
    next.runIds.forEach((runId) => current.runIds.add(runId));
    next.failureSignatureIds.forEach((signatureId) =>
        current.failureSignatureIds.add(signatureId)
    );
}

function freezeAgent(agent: MutableMapAgent): FleetWorldMapAgent {
    return {
        ...agent,
        runIds: [...agent.runIds].sort(),
        failureSignatureIds: [...agent.failureSignatureIds].sort(),
    };
}

function deriveRegions(
    reports: readonly ControlFleetRunReport[],
): readonly FleetWorldMapRegion[] {
    type MutableRegion = {
        region: string;
        provider?: string;
        key: string;
        location: FleetWorldMapLocation;
        agentIds: Set<string>;
        passed: number;
        failed: number;
        missing: number;
        stale: number;
        failures: Map<string, number>;
        latestRunId?: string;
    };
    const regions = new Map<string, MutableRegion>();
    for (const report of reports) {
        for (const outcome of report.agents) {
            const identity = regionIdentity(outcome.label);
            const location = locationFromLabel(outcome.label);
            if (!location) {
                continue;
            }
            const current = regions.get(identity) ?? {
                region: outcome.label.region ?? 'unlabeled',
                provider: outcome.label.provider,
                key: identity,
                location,
                agentIds: new Set<string>(),
                passed: 0,
                failed: 0,
                missing: 0,
                stale: 0,
                failures: new Map<string, number>(),
                latestRunId: report.distributedRunId,
            };
            current.agentIds.add(outcome.agentId);
            if (outcome.state === 'passed') current.passed += 1;
            if (outcome.state === 'failed' || outcome.state === 'timed-out') current.failed += 1;
            if (outcome.missing || outcome.state === 'missing') current.missing += 1;
            if (outcome.stale) current.stale += 1;
            outcome.failureSignatureIds.forEach((signatureId) => {
                current.failures.set(
                    signatureId,
                    (current.failures.get(signatureId) ?? 0) + 1,
                );
            });
            regions.set(identity, current);
        }
    }

    return [...regions.values()]
        .map((region) => {
            const total = region.passed + region.failed + region.missing;
            return {
                region: region.region,
                provider: region.provider,
                key: region.key,
                location: region.location,
                agentCount: region.agentIds.size,
                passed: region.passed,
                failed: region.failed,
                missing: region.missing,
                stale: region.stale,
                passRate: total > 0 ? region.passed / total : 0,
                dominantFailureSignatureId: topFailure(region.failures),
                latestRunId: region.latestRunId,
            };
        })
        .sort((left, right) =>
            right.failed - left.failed ||
            left.region.localeCompare(right.region)
        );
}

function deriveRoutes(
    evidence: readonly FleetWorldMapRouteEvidence[],
    agents: ReadonlyMap<string, MutableMapAgent>,
): readonly FleetWorldMapRoute[] {
    type MutableRoute = {
        routeId: string;
        sourceAgentId: string;
        targetAgentId: string;
        source: FleetWorldMapLocation;
        target: FleetWorldMapLocation;
        kind: 'observed-route';
        transport?: string;
        eventCount: number;
        failedCount: number;
        lastSeenAtEpochMs?: number;
    };
    const routes = new Map<string, MutableRoute>();
    for (const entry of evidence) {
        const source = agents.get(entry.sourceAgentId)?.location;
        const target = agents.get(entry.targetAgentId)?.location;
        if (!source || !target) {
            continue;
        }
        const identity = tupleIdentity([
            entry.sourceAgentId,
            entry.targetAgentId,
            entry.transport ?? null,
        ]);
        const routeId = fleetRouteId(entry);
        const current = routes.get(identity) ?? {
            routeId,
            sourceAgentId: entry.sourceAgentId,
            targetAgentId: entry.targetAgentId,
            source,
            target,
            kind: 'observed-route' as const,
            transport: entry.transport,
            eventCount: 0,
            failedCount: 0,
            lastSeenAtEpochMs: entry.atEpochMs,
        };
        current.eventCount += 1;
        current.failedCount += entry.failed ? 1 : 0;
        current.lastSeenAtEpochMs = maxDefined(current.lastSeenAtEpochMs, entry.atEpochMs);
        routes.set(identity, current);
    }
    return [...routes.values()]
        .sort((left, right) =>
            (right.lastSeenAtEpochMs ?? 0) - (left.lastSeenAtEpochMs ?? 0) ||
            left.routeId.localeCompare(right.routeId)
        );
}

function stateFromOutcome(
    outcome: ControlFleetAgentRunOutcome,
): FleetWorldMapAgentState {
    if (outcome.state === 'cancelled' || outcome.state === 'timed-out') {
        return outcome.state === 'timed-out' ? 'failed' : 'unknown';
    }
    return outcome.state;
}

function stateFromLiveRow(row: ControlAgentBoardRow): FleetWorldMapAgentState {
    if (row.targetStatus === 'stale') {
        return 'stale';
    }
    if (row.targetStatus === 'offline' || !row.connected) {
        return 'offline';
    }
    return 'connected';
}

function locationFromLabel(
    label: ControlFleetAgentLabel,
): FleetWorldMapLocation | undefined {
    return resolveFleetWorldMapLocation({
        location: label.location,
        region: label.region,
        provider: label.provider,
        datacenter: label.datacenter,
    });
}

function regionIdentity(label: ControlFleetAgentLabel): string {
    return `${encodeURIComponent(label.region ?? 'unlabeled')} / ${
        encodeURIComponent(label.provider ?? 'unknown')
    }`;
}

function fleetRouteId(entry: FleetWorldMapRouteEvidence): string {
    const transport = entry.transport === undefined
        ? 'unknown'
        : entry.transport === 'unknown'
        ? 'unknown%00'
        : encodeURIComponent(entry.transport);
    return `${encodeURIComponent(entry.sourceAgentId)}->${
        encodeURIComponent(entry.targetAgentId)
    }:${transport}`;
}

function tupleIdentity(parts: readonly (string | null)[]): string {
    return JSON.stringify(parts);
}

function topFailure(
    failures: ReadonlyMap<string, number>,
): string | undefined {
    return [...failures.entries()]
        .sort((left, right) => right[1] - left[1])[0]?.[0];
}

function preferredLocation(
    current: FleetWorldMapLocation | undefined,
    next: FleetWorldMapLocation | undefined,
): FleetWorldMapLocation | undefined {
    if (!current) return next;
    if (!next) return current;
    return locationRank(next) < locationRank(current) ? next : current;
}

function locationRank(location: FleetWorldMapLocation): number {
    if (location.source === 'agent') return 0;
    if (location.source === 'datacenter-lookup') return 1;
    return 2;
}

function preferredState(
    current: FleetWorldMapAgentState,
    next: FleetWorldMapAgentState,
): FleetWorldMapAgentState {
    const rank: Record<FleetWorldMapAgentState, number> = {
        failed: 0,
        missing: 1,
        stale: 2,
        running: 3,
        connected: 4,
        offline: 5,
        passed: 6,
        unknown: 7,
    };
    return rank[next] < rank[current] ? next : current;
}

function maxDefined(
    left: number | undefined,
    right: number | undefined,
): number | undefined {
    if (left === undefined) return right;
    if (right === undefined) return left;
    return Math.max(left, right);
}

export type { ControlFleetFailureSignature };
