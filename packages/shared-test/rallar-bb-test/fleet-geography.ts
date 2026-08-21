import type { ControlRunSnapshot } from './control-snapshots.ts';
import type { RallarBlackBoxGeoLocation } from './distributed-run.ts';
import type { ControlFleetAgentRunOutcome, ControlFleetRunReport } from './fleet-report.ts';

export const FLEET_GEOGRAPHY_ROUTE_EVIDENCE_LABEL =
    'Observed in the bounded control snapshot event window; not a complete network topology.';

export type FleetGeographyLiveState =
    | 'connected'
    | 'offline'
    | 'stale'
    | 'unknown';

export type FleetGeographyLiveAgentEvidence = Readonly<{
    agentId: string;
    state: FleetGeographyLiveState;
    connected: boolean;
    synthetic: boolean;
    observedAtEpochMs?: number;
    lastSeenAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    region?: string;
    provider?: string;
    datacenter?: string;
    location?: RallarBlackBoxGeoLocation;
    activeRunIds?: readonly string[];
}>;

export type FleetGeographyLocationSource =
    | 'live-explicit'
    | 'historical-explicit'
    | 'live-datacenter-lookup'
    | 'live-region-lookup'
    | 'historical-datacenter-lookup'
    | 'historical-region-lookup';

export type FleetGeographyDocumentedLocationSource =
    | 'explicit'
    | 'datacenter-lookup'
    | 'region-lookup';

export type FleetGeographyDocumentedLocationInput = Readonly<{
    location?: RallarBlackBoxGeoLocation;
    region?: string;
    provider?: string;
    datacenter?: string;
}>;

export type FleetGeographyDocumentedLocation =
    & RallarBlackBoxGeoLocation
    & Readonly<{
        label: string;
        precision: 'exact' | 'approximate';
        source: FleetGeographyDocumentedLocationSource;
    }>;

export type FleetGeographyLocation =
    & RallarBlackBoxGeoLocation
    & Readonly<{
        label: string;
        precision: 'exact' | 'approximate';
        source: FleetGeographyLocationSource;
        evidenceKind: 'live' | 'historical';
        observedAtEpochMs?: number;
        distributedRunId?: string;
        generatedAtEpochMs?: number;
    }>;

export type FleetGeographyHistoricalOutcome = Readonly<{
    distributedRunId: string;
    controlRunId: string;
    generatedAtEpochMs: number;
    state: ControlFleetAgentRunOutcome['state'];
    ok: boolean;
    missing: boolean;
    stale: boolean;
    region?: string;
    provider?: string;
    datacenter?: string;
}>;

export type FleetGeographyAgentEvidence = Readonly<{
    agentId: string;
    location?: FleetGeographyLocation;
    live?: Readonly<{
        state: FleetGeographyLiveState;
        connected: boolean;
        synthetic: boolean;
        observedAtEpochMs?: number;
        lastSeenAtEpochMs?: number;
        lastHeartbeatAtEpochMs?: number;
        region?: string;
        provider?: string;
        datacenter?: string;
        activeRunIds: readonly string[];
    }>;
    historical?: Readonly<{
        latest: FleetGeographyHistoricalOutcome;
        outcomeCount: number;
        failedOutcomes: number;
        missingOutcomes: number;
        runIds: readonly string[];
        failureSignatureIds: readonly string[];
    }>;
}>;

export type FleetGeographyRegionEvidence = Readonly<{
    key: string;
    region: string;
    provider?: string;
    location: FleetGeographyLocation;
    agentCount: number;
    outcomeCount: number;
    passed: number;
    failed: number;
    failedAgentCount: number;
    missing: number;
    stale: number;
    passRate: number;
    dominantFailureSignatureId?: string;
    latestDistributedRunId: string;
}>;

export type FleetGeographyRouteObservation = Readonly<{
    sourceAgentId: string;
    targetAgentId: string;
    atEpochMs?: number;
    transport?: string;
    failed: boolean;
}>;

export type FleetGeographyRouteEvidenceWindow = Readonly<{
    source: 'bounded-control-snapshot-events';
    controlRunId?: string;
    sourceEventCount: number;
    observations: readonly FleetGeographyRouteObservation[];
    topologyComplete: false;
    label: typeof FLEET_GEOGRAPHY_ROUTE_EVIDENCE_LABEL;
}>;

export type FleetGeographyRouteExtractionOptions = Readonly<{
    observationOrder?: 'stable' | 'source';
}>;

export type FleetGeographyRoute = Readonly<{
    routeId: string;
    sourceAgentId: string;
    targetAgentId: string;
    source: FleetGeographyLocation;
    target: FleetGeographyLocation;
    transport?: string;
    eventCount: number;
    failedCount: number;
    lastSeenAtEpochMs?: number;
}>;

export type FleetGeographyModel = Readonly<{
    agents: readonly FleetGeographyAgentEvidence[];
    regions: readonly FleetGeographyRegionEvidence[];
    routes: readonly FleetGeographyRoute[];
    unresolvedAgentIds: readonly string[];
    routeEvidence: Readonly<{
        source: 'bounded-control-snapshot-events';
        controlRunId?: string;
        sourceEventCount: number;
        explicitObservationCount: number;
        resolvedObservationCount: number;
        unresolvedEndpointObservationCount: number;
        unresolvedEndpointAgentIds: readonly string[];
        failedObservationCount: number;
        topologyComplete: false;
        label: typeof FLEET_GEOGRAPHY_ROUTE_EVIDENCE_LABEL;
    }>;
    summary: Readonly<{
        agents: number;
        liveAgents: number;
        historicalAgents: number;
        unresolvedAgents: number;
        regions: number;
        routes: number;
        failedHistoricalAgents: number;
        failedHistoricalOutcomes: number;
        failedRouteObservations: number;
    }>;
}>;

export type DeriveFleetGeographyInput = Readonly<{
    liveAgents?: readonly FleetGeographyLiveAgentEvidence[];
    reports?: readonly ControlFleetRunReport[];
    routeEvidence?: FleetGeographyRouteEvidenceWindow;
}>;

type HistoricalRecord = Readonly<{
    report: ControlFleetRunReport;
    outcome: ControlFleetAgentRunOutcome;
}>;

type MutableHistoricalRegion = {
    key: string;
    region: string;
    provider?: string;
    locationRecord: HistoricalRecord;
    location: FleetGeographyLocation;
    agentIds: Set<string>;
    failedAgentIds: Set<string>;
    outcomeCount: number;
    passed: number;
    failed: number;
    missing: number;
    stale: number;
    failures: Map<string, number>;
    latestRecord: HistoricalRecord;
};

export type FleetGeographyHistoricalCollectionWork = Readonly<{
    reportVisits: number;
    outcomeVisits: number;
}>;

const FLEET_GEOGRAPHY_HISTORY_SOURCE = Symbol('fleet-geography-history-source');

type FleetGeographyHistoricalSource = Readonly<{
    agentsById: ReadonlyMap<string, FleetGeographyAgentEvidence>;
}>;

export type FleetGeographyHistoricalCollection = Readonly<{
    regions: readonly FleetGeographyRegionEvidence[];
    work: FleetGeographyHistoricalCollectionWork;
    [FLEET_GEOGRAPHY_HISTORY_SOURCE]: FleetGeographyHistoricalSource;
}>;

const DATACENTER_LOCATIONS: Readonly<Record<string, Readonly<RallarBlackBoxGeoLocation & { label: string; }>>> = {
    'hetzner/fsn1': {
        latitude: 52.5333,
        longitude: 13.3833,
        label: 'Hetzner FSN1, Germany'
    },
    'hetzner/nbg1': {
        latitude: 49.4521,
        longitude: 11.0767,
        label: 'Hetzner NBG1, Germany'
    },
    'hetzner/hel1': {
        latitude: 60.1699,
        longitude: 24.9384,
        label: 'Hetzner HEL1, Finland'
    },
    'hetzner/ash': {
        latitude: 39.0438,
        longitude: -77.4874,
        label: 'Hetzner ASH, US East'
    },
    'hetzner/hil': {
        latitude: 45.5229,
        longitude: -122.9898,
        label: 'Hetzner HIL, US West'
    }
};

const REGION_LOCATIONS: Readonly<Record<string, Readonly<RallarBlackBoxGeoLocation & { label: string; }>>> = {
    'eu-north': {
        latitude: 60,
        longitude: 18,
        label: 'Europe north'
    },
    'eu-central': {
        latitude: 50.8,
        longitude: 10.3,
        label: 'Europe central'
    },
    'eu-west': {
        latitude: 53,
        longitude: -7.5,
        label: 'Europe west'
    },
    'us-east': {
        latitude: 39.5,
        longitude: -77,
        label: 'US east'
    },
    'us-west': {
        latitude: 45.5,
        longitude: -122.6,
        label: 'US west'
    }
};

export function deriveFleetGeography(
    input: DeriveFleetGeographyInput
): FleetGeographyModel {
    return deriveFleetGeographyFromHistoricalCollection(
        createFleetGeographyHistoricalCollection(input.reports ?? []),
        {
            liveAgents: input.liveAgents,
            routeEvidence: input.routeEvidence
        }
    );
}

export function createFleetGeographyHistoricalCollection(
    reports: readonly ControlFleetRunReport[]
): FleetGeographyHistoricalCollection {
    const work = { reportVisits: 0, outcomeVisits: 0 };
    const historical = indexHistoricalEvidence(reports, work);
    const recordsByAgent = historical.recordsByAgent;
    const agents = [...recordsByAgent.entries()].map(([agentId, records]) => deriveHistoricalAgent(agentId, records));
    return {
        regions: historical.regions,
        work,
        [FLEET_GEOGRAPHY_HISTORY_SOURCE]: {
            agentsById: new Map(agents.map((agent) => [agent.agentId, agent]))
        }
    };
}

export function deriveFleetGeographyFromHistoricalCollection(
    history: FleetGeographyHistoricalCollection,
    input: Readonly<{
        liveAgents?: readonly FleetGeographyLiveAgentEvidence[];
        routeEvidence?: FleetGeographyRouteEvidenceWindow;
    }> = {}
): FleetGeographyModel {
    const liveByAgent = groupLiveEvidence(input.liveAgents ?? []);
    const historical = history[FLEET_GEOGRAPHY_HISTORY_SOURCE];
    const agentIds = [
        ...new Set([
            ...liveByAgent.keys(),
            ...historical.agentsById.keys()
        ])
    ].sort(compareText);
    const agents = agentIds.map((agentId) => {
        const liveEvidence = liveByAgent.get(agentId) ?? [];
        const historicalAgent = historical.agentsById.get(agentId);
        if (liveEvidence.length === 0 && historicalAgent) {
            return historicalAgent;
        }
        return composeAgentWithCachedHistory(
            agentId,
            liveEvidence,
            historicalAgent
        );
    });
    const agentsById = new Map(agents.map((agent) => [agent.agentId, agent]));
    const routeModel = deriveRoutes(input.routeEvidence, agentsById);
    const failedHistoricalAgents = agents.filter((agent) => (agent.historical?.failedOutcomes ?? 0) > 0).length;
    const failedHistoricalOutcomes = agents.reduce(
        (count, agent) => count + (agent.historical?.failedOutcomes ?? 0),
        0
    );
    const unresolvedAgentIds = agents
        .filter((agent) => agent.location === undefined)
        .map((agent) => agent.agentId);
    const regions = history.regions;

    return {
        agents,
        regions,
        routes: routeModel.routes,
        unresolvedAgentIds,
        routeEvidence: routeModel.evidence,
        summary: {
            agents: agents.length,
            liveAgents: agents.filter((agent) => agent.live !== undefined).length,
            historicalAgents: agents.filter((agent) => agent.historical !== undefined)
                .length,
            unresolvedAgents: unresolvedAgentIds.length,
            regions: regions.length,
            routes: routeModel.routes.length,
            failedHistoricalAgents,
            failedHistoricalOutcomes,
            failedRouteObservations: routeModel.evidence.failedObservationCount
        }
    };
}

export function fleetGeographyRouteEvidenceFromControlRun(
    run: ControlRunSnapshot | undefined,
    options: FleetGeographyRouteExtractionOptions = {}
): FleetGeographyRouteEvidenceWindow {
    const observations = (run?.events ?? []).flatMap((event) => {
        const payload = asRecord(event.payload);
        const data = asRecord(payload.data);
        const requestedTargets = [
            stringValue(payload.targetAgentId),
            stringValue(payload.destinationAgentId),
            stringValue(payload.remoteAgentId),
            ...stringArray(payload.targetAgentIds),
            ...stringArray(payload.destinationAgentIds),
            ...stringArray(data.targetAgentIds)
        ];
        const targets = (options.observationOrder === 'source'
            ? uniqueNormalizedStringsInOrder(requestedTargets)
            : uniqueSortedStrings(requestedTargets))
            .filter((targetAgentId) => targetAgentId !== event.agentId);
        const transport = stringValue(payload.transport) ??
            stringValue(data.transport);
        const failed = payload.failed === true || payload.ok === false ||
            payload.severity === 'error';
        return targets.map((targetAgentId): FleetGeographyRouteObservation => ({
            sourceAgentId: event.agentId,
            targetAgentId,
            atEpochMs: event.atEpochMs,
            ...(transport ? { transport } : {}),
            failed
        }));
    });
    const orderedObservations = options.observationOrder === 'source'
        ? observations
        : [...observations].sort(compareRouteObservations);

    return {
        source: 'bounded-control-snapshot-events',
        ...(run ? { controlRunId: run.runId } : {}),
        sourceEventCount: run?.events.length ?? 0,
        observations: orderedObservations,
        topologyComplete: false,
        label: FLEET_GEOGRAPHY_ROUTE_EVIDENCE_LABEL
    };
}

export function resolveFleetGeographyDocumentedLocation(
    input: FleetGeographyDocumentedLocationInput
): FleetGeographyDocumentedLocation | undefined {
    const explicit = explicitLocation(input.location);
    if (explicit) {
        return { ...explicit, source: 'explicit' };
    }
    const lookup = lookupLocation(input);
    return lookup
        ? {
            ...lookup.location,
            source: lookup.kind === 'datacenter'
                ? 'datacenter-lookup'
                : 'region-lookup'
        }
        : undefined;
}

function groupLiveEvidence(
    evidence: readonly FleetGeographyLiveAgentEvidence[]
): ReadonlyMap<string, readonly FleetGeographyLiveAgentEvidence[]> {
    const grouped = new Map<string, FleetGeographyLiveAgentEvidence[]>();
    for (const item of evidence) {
        const agentId = stringValue(item.agentId);
        if (!agentId) {
            continue;
        }
        const current = grouped.get(agentId) ?? [];
        current.push(item);
        grouped.set(agentId, current);
    }
    for (const [agentId, items] of grouped) {
        grouped.set(agentId, [...items].sort(compareLiveEvidence));
    }
    return grouped;
}

function indexHistoricalEvidence(
    reports: readonly ControlFleetRunReport[],
    work: { reportVisits: number; outcomeVisits: number; }
): Readonly<{
    recordsByAgent: ReadonlyMap<string, readonly HistoricalRecord[]>;
    regions: readonly FleetGeographyRegionEvidence[];
}> {
    const grouped = new Map<string, HistoricalRecord[]>();
    const regions = new Map<string, MutableHistoricalRegion>();
    for (const report of reports) {
        work.reportVisits += 1;
        for (const outcome of report.agents) {
            work.outcomeVisits += 1;
            const record = { report, outcome };
            indexHistoricalRegion(regions, record);
            const agentId = stringValue(outcome.agentId);
            if (!agentId) {
                continue;
            }
            const current = grouped.get(agentId) ?? [];
            current.push(record);
            grouped.set(agentId, current);
        }
    }
    for (const [agentId, records] of grouped) {
        grouped.set(agentId, [...records].sort(compareHistoricalRecords));
    }
    return {
        recordsByAgent: grouped,
        regions: historicalRegionsFromIndex(regions)
    };
}

function deriveHistoricalAgent(
    agentId: string,
    historicalRecords: readonly HistoricalRecord[]
): FleetGeographyAgentEvidence {
    const latestHistorical = historicalRecords[0];
    const runIds = uniqueInOrder(historicalRecords.map((record) => record.report.distributedRunId));
    const failureSignatureIds = uniqueSortedStrings(historicalRecords.flatMap(
        (record) => record.outcome.failureSignatureIds
    ));

    return {
        agentId,
        location: resolveHistoricalAgentLocation(historicalRecords),
        ...(latestHistorical
            ? {
                historical: {
                    latest: historicalOutcome(latestHistorical),
                    outcomeCount: historicalRecords.length,
                    failedOutcomes: historicalRecords.filter((record) => isFailedOutcome(record.outcome)).length,
                    missingOutcomes: historicalRecords.filter((record) => isMissingOutcome(record.outcome)).length,
                    runIds,
                    failureSignatureIds
                }
            }
            : {})
    };
}

function composeAgentWithCachedHistory(
    agentId: string,
    liveEvidence: readonly FleetGeographyLiveAgentEvidence[],
    historicalAgent: FleetGeographyAgentEvidence | undefined
): FleetGeographyAgentEvidence {
    const currentLive = liveEvidence[0];
    return {
        agentId,
        location: resolveAgentLocationFromCachedHistory(
            liveEvidence,
            historicalAgent?.location
        ),
        ...(currentLive
            ? {
                live: {
                    state: currentLive.state,
                    connected: currentLive.connected,
                    synthetic: currentLive.synthetic,
                    observedAtEpochMs: currentLive.observedAtEpochMs,
                    lastSeenAtEpochMs: currentLive.lastSeenAtEpochMs,
                    lastHeartbeatAtEpochMs: currentLive.lastHeartbeatAtEpochMs,
                    region: normalizedText(currentLive.region),
                    provider: normalizedText(currentLive.provider),
                    datacenter: normalizedText(currentLive.datacenter),
                    activeRunIds: uniqueSortedStrings(
                        currentLive.activeRunIds ?? []
                    )
                }
            }
            : {}),
        ...(historicalAgent?.historical
            ? { historical: historicalAgent.historical }
            : {})
    };
}

function historicalOutcome(
    record: HistoricalRecord
): FleetGeographyHistoricalOutcome {
    return {
        distributedRunId: record.report.distributedRunId,
        controlRunId: record.report.controlRunId,
        generatedAtEpochMs: record.report.generatedAtEpochMs,
        state: record.outcome.state,
        ok: record.outcome.ok,
        missing: record.outcome.missing,
        stale: record.outcome.stale,
        region: normalizedText(record.outcome.label.region),
        provider: normalizedText(record.outcome.label.provider),
        datacenter: normalizedText(record.outcome.label.datacenter)
    };
}

function resolveHistoricalAgentLocation(
    historicalRecords: readonly HistoricalRecord[]
): FleetGeographyLocation | undefined {
    for (const record of historicalRecords) {
        const location = explicitLocation(record.outcome.label.location);
        if (location) {
            return {
                ...location,
                source: 'historical-explicit',
                evidenceKind: 'historical',
                distributedRunId: record.report.distributedRunId,
                generatedAtEpochMs: record.report.generatedAtEpochMs
            };
        }
    }
    for (const record of historicalRecords) {
        const location = lookupLocation(record.outcome.label);
        if (location) {
            return {
                ...location.location,
                source: location.kind === 'datacenter'
                    ? 'historical-datacenter-lookup'
                    : 'historical-region-lookup',
                evidenceKind: 'historical',
                distributedRunId: record.report.distributedRunId,
                generatedAtEpochMs: record.report.generatedAtEpochMs
            };
        }
    }
    return undefined;
}

function resolveAgentLocationFromCachedHistory(
    liveEvidence: readonly FleetGeographyLiveAgentEvidence[],
    historicalLocation: FleetGeographyLocation | undefined
): FleetGeographyLocation | undefined {
    for (const evidence of liveEvidence) {
        const location = explicitLocation(evidence.location);
        if (location) {
            return {
                ...location,
                source: 'live-explicit',
                evidenceKind: 'live',
                observedAtEpochMs: evidence.observedAtEpochMs
            };
        }
    }
    if (historicalLocation?.source === 'historical-explicit') {
        return historicalLocation;
    }
    for (const evidence of liveEvidence) {
        const location = lookupLocation(evidence);
        if (location) {
            return {
                ...location.location,
                source: location.kind === 'datacenter'
                    ? 'live-datacenter-lookup'
                    : 'live-region-lookup',
                evidenceKind: 'live',
                observedAtEpochMs: evidence.observedAtEpochMs
            };
        }
    }
    return historicalLocation;
}

function indexHistoricalRegion(
    regions: Map<string, MutableHistoricalRegion>,
    record: HistoricalRecord
): void {
    const location = historicalRecordLocation(record);
    if (!location) {
        return;
    }
    const normalizedRegion = normalizeKey(record.outcome.label.region);
    const provider = normalizeKey(record.outcome.label.provider);
    const region = normalizedRegion ?? 'unlabeled';
    const identity = tupleIdentity([normalizedRegion ?? null, provider ?? null]);
    const current = regions.get(identity) ?? {
        key: fleetRegionPublicId(normalizedRegion, provider),
        region,
        provider,
        locationRecord: record,
        location,
        agentIds: new Set<string>(),
        failedAgentIds: new Set<string>(),
        outcomeCount: 0,
        passed: 0,
        failed: 0,
        missing: 0,
        stale: 0,
        failures: new Map<string, number>(),
        latestRecord: record
    };
    if (compareRegionLocations(record, location, current) < 0) {
        current.locationRecord = record;
        current.location = location;
    }
    if (compareHistoricalRecords(record, current.latestRecord) < 0) {
        current.latestRecord = record;
    }
    current.agentIds.add(record.outcome.agentId);
    current.outcomeCount += 1;
    if (record.outcome.state === 'passed') {
        current.passed += 1;
    }
    if (isFailedOutcome(record.outcome)) {
        current.failed += 1;
        current.failedAgentIds.add(record.outcome.agentId);
    }
    if (isMissingOutcome(record.outcome)) {
        current.missing += 1;
    }
    if (record.outcome.stale) {
        current.stale += 1;
    }
    for (const signatureId of record.outcome.failureSignatureIds) {
        current.failures.set(
            signatureId,
            (current.failures.get(signatureId) ?? 0) + 1
        );
    }
    regions.set(identity, current);
}

function historicalRegionsFromIndex(
    regions: ReadonlyMap<string, MutableHistoricalRegion>
): readonly FleetGeographyRegionEvidence[] {
    return [...regions.values()].map((region): FleetGeographyRegionEvidence => {
        const decidedOutcomes = region.passed + region.failed + region.missing;
        return {
            key: region.key,
            region: region.region,
            provider: region.provider,
            location: region.location,
            agentCount: region.agentIds.size,
            outcomeCount: region.outcomeCount,
            passed: region.passed,
            failed: region.failed,
            failedAgentCount: region.failedAgentIds.size,
            missing: region.missing,
            stale: region.stale,
            passRate: decidedOutcomes > 0
                ? region.passed / decidedOutcomes
                : 0,
            dominantFailureSignatureId: dominantFailure(region.failures),
            latestDistributedRunId: region.latestRecord.report.distributedRunId
        };
    }).sort((left, right) => right.failed - left.failed || compareText(left.key, right.key));
}

function historicalRecordLocation(
    record: HistoricalRecord
): FleetGeographyLocation | undefined {
    const explicit = explicitLocation(record.outcome.label.location);
    if (explicit) {
        return {
            ...explicit,
            source: 'historical-explicit',
            evidenceKind: 'historical',
            distributedRunId: record.report.distributedRunId,
            generatedAtEpochMs: record.report.generatedAtEpochMs
        };
    }
    const lookup = lookupLocation(record.outcome.label);
    return lookup
        ? {
            ...lookup.location,
            source: lookup.kind === 'datacenter'
                ? 'historical-datacenter-lookup'
                : 'historical-region-lookup',
            evidenceKind: 'historical',
            distributedRunId: record.report.distributedRunId,
            generatedAtEpochMs: record.report.generatedAtEpochMs
        }
        : undefined;
}

function compareRegionLocations(
    record: HistoricalRecord,
    location: FleetGeographyLocation,
    current: Readonly<{
        locationRecord: HistoricalRecord;
        location: FleetGeographyLocation;
    }>
): number {
    return locationRank(location) - locationRank(current.location) ||
        compareHistoricalRecords(record, current.locationRecord);
}

function deriveRoutes(
    window: FleetGeographyRouteEvidenceWindow | undefined,
    agents: ReadonlyMap<string, FleetGeographyAgentEvidence>
): Readonly<{
    routes: readonly FleetGeographyRoute[];
    evidence: FleetGeographyModel['routeEvidence'];
}> {
    type MutableRoute = {
        routeId: string;
        sourceAgentId: string;
        targetAgentId: string;
        source: FleetGeographyLocation;
        target: FleetGeographyLocation;
        transport?: string;
        eventCount: number;
        failedCount: number;
        lastSeenAtEpochMs?: number;
    };
    const observations = [...(window?.observations ?? [])]
        .sort(compareRouteObservations);
    const routes = new Map<string, MutableRoute>();
    const unresolvedEndpointAgentIds = new Set<string>();
    let resolvedObservationCount = 0;
    let unresolvedEndpointObservationCount = 0;
    let failedObservationCount = 0;

    for (const observation of observations) {
        if (observation.failed) {
            failedObservationCount += 1;
        }
        const source = agents.get(observation.sourceAgentId)?.location;
        const target = agents.get(observation.targetAgentId)?.location;
        if (!source || !target) {
            unresolvedEndpointObservationCount += 1;
            if (!source) {
                unresolvedEndpointAgentIds.add(observation.sourceAgentId);
            }
            if (!target) {
                unresolvedEndpointAgentIds.add(observation.targetAgentId);
            }
            continue;
        }
        resolvedObservationCount += 1;
        const identity = tupleIdentity([
            observation.sourceAgentId,
            observation.targetAgentId,
            observation.transport ?? null
        ]);
        const routeId = fleetRouteId(observation);
        const current = routes.get(identity) ?? {
            routeId,
            sourceAgentId: observation.sourceAgentId,
            targetAgentId: observation.targetAgentId,
            source,
            target,
            transport: observation.transport,
            eventCount: 0,
            failedCount: 0,
            lastSeenAtEpochMs: observation.atEpochMs
        };
        current.eventCount += 1;
        if (observation.failed) {
            current.failedCount += 1;
        }
        current.lastSeenAtEpochMs = maxDefined(
            current.lastSeenAtEpochMs,
            observation.atEpochMs
        );
        routes.set(identity, current);
    }

    const routeList = [...routes.values()].sort((left, right) =>
        (right.lastSeenAtEpochMs ?? -1) -
            (left.lastSeenAtEpochMs ?? -1) ||
        compareText(left.routeId, right.routeId)
    );
    return {
        routes: routeList,
        evidence: {
            source: 'bounded-control-snapshot-events',
            ...(window?.controlRunId
                ? { controlRunId: window.controlRunId }
                : {}),
            sourceEventCount: window?.sourceEventCount ?? 0,
            explicitObservationCount: observations.length,
            resolvedObservationCount,
            unresolvedEndpointObservationCount,
            unresolvedEndpointAgentIds: [...unresolvedEndpointAgentIds].sort(compareText),
            failedObservationCount,
            topologyComplete: false,
            label: FLEET_GEOGRAPHY_ROUTE_EVIDENCE_LABEL
        }
    };
}

function explicitLocation(
    location: RallarBlackBoxGeoLocation | undefined
):
    | Readonly<
        RallarBlackBoxGeoLocation & {
            label: string;
            precision: 'exact' | 'approximate';
        }
    >
    | undefined {
    if (
        !location ||
        !Number.isFinite(location.latitude) ||
        !Number.isFinite(location.longitude) ||
        location.latitude < -90 ||
        location.latitude > 90 ||
        location.longitude < -180 ||
        location.longitude > 180
    ) {
        return undefined;
    }
    return {
        latitude: location.latitude,
        longitude: location.longitude,
        label: location.label ?? 'Agent location',
        precision: location.precision ?? 'exact'
    };
}

function lookupLocation(
    input: Readonly<{
        region?: string;
        provider?: string;
        datacenter?: string;
    }>
):
    | Readonly<{
        kind: 'datacenter' | 'region';
        location: Readonly<
            RallarBlackBoxGeoLocation & {
                label: string;
                precision: 'approximate';
            }
        >;
    }>
    | undefined {
    const provider = normalizeKey(input.provider);
    const datacenter = normalizeKey(input.datacenter);
    if (provider && datacenter) {
        const location = DATACENTER_LOCATIONS[`${provider}/${datacenter}`];
        if (location) {
            return {
                kind: 'datacenter',
                location: { ...location, precision: 'approximate' }
            };
        }
    }
    const region = normalizeKey(input.region);
    const location = region ? REGION_LOCATIONS[region] : undefined;
    return location
        ? {
            kind: 'region',
            location: { ...location, precision: 'approximate' }
        }
        : undefined;
}

function compareLiveEvidence(
    left: FleetGeographyLiveAgentEvidence,
    right: FleetGeographyLiveAgentEvidence
): number {
    return (right.observedAtEpochMs ?? -1) -
            (left.observedAtEpochMs ?? -1) ||
        (right.lastSeenAtEpochMs ?? -1) -
            (left.lastSeenAtEpochMs ?? -1) ||
        (right.lastHeartbeatAtEpochMs ?? -1) -
            (left.lastHeartbeatAtEpochMs ?? -1) ||
        compareText(liveEvidenceKey(left), liveEvidenceKey(right));
}

function liveEvidenceKey(evidence: FleetGeographyLiveAgentEvidence): string {
    return tupleIdentity([
        evidence.agentId,
        evidence.state,
        evidence.connected,
        evidence.synthetic,
        normalizedText(evidence.region) ?? null,
        normalizedText(evidence.provider) ?? null,
        normalizedText(evidence.datacenter) ?? null,
        evidence.location?.latitude ?? null,
        evidence.location?.longitude ?? null,
        evidence.location?.label ?? null,
        evidence.location?.precision ?? null,
        [...(evidence.activeRunIds ?? [])].sort(compareText)
    ]);
}

function tupleIdentity(parts: readonly unknown[]): string {
    return JSON.stringify(parts);
}

function fleetRegionPublicId(
    region: string | undefined,
    provider: string | undefined
): string {
    return `${publicIdentitySegment(region, 'unlabeled')} / ${publicIdentitySegment(provider, 'unknown')}`;
}

function publicIdentitySegment(
    value: string | undefined,
    missingLabel: string
): string {
    if (value === undefined) {
        return missingLabel;
    }
    const encoded = encodeOperatorText(value);
    return value === missingLabel ? `${encoded}:literal` : encoded;
}

function encodeOperatorText(value: string): string {
    let encoded = '';
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (
            codeUnit >= 0xd800 && codeUnit <= 0xdbff &&
            index + 1 < value.length
        ) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                index += 1;
                continue;
            }
        }
        else if (codeUnit < 0xd800 || codeUnit > 0xdfff) {
            continue;
        }
        encoded += encodeURIComponent(value.slice(start, index));
        encoded += `%u${codeUnit.toString(16).toUpperCase().padStart(4, '0')}`;
        start = index + 1;
    }
    return encoded + encodeURIComponent(value.slice(start));
}

function fleetRouteId(observation: FleetGeographyRouteObservation): string {
    const transport = fleetRouteTransportId(observation.transport);
    return `${encodeOperatorText(observation.sourceAgentId)}->${
        encodeOperatorText(observation.targetAgentId)
    }:${transport}`;
}

function fleetRouteTransportId(transport: string | undefined): string {
    if (transport === undefined) {
        return 'unknown';
    }
    if (transport === 'unknown') {
        return 'unknown%00';
    }
    const encoded = encodeOperatorText(transport);
    return encoded === 'unknown%00' ? `${encoded}:literal` : encoded;
}

function compareHistoricalRecords(
    left: HistoricalRecord,
    right: HistoricalRecord
): number {
    return right.report.generatedAtEpochMs - left.report.generatedAtEpochMs ||
        compareText(
            left.report.distributedRunId,
            right.report.distributedRunId
        ) ||
        compareText(outcomeKey(left.outcome), outcomeKey(right.outcome));
}

function outcomeKey(outcome: ControlFleetAgentRunOutcome): string {
    return tupleIdentity([
        outcome.agentId,
        outcome.state,
        outcome.ok,
        outcome.missing,
        outcome.stale,
        normalizedText(outcome.label.region) ?? null,
        normalizedText(outcome.label.provider) ?? null,
        normalizedText(outcome.label.datacenter) ?? null,
        outcome.label.location?.latitude ?? null,
        outcome.label.location?.longitude ?? null,
        outcome.label.location?.label ?? null,
        outcome.label.location?.precision ?? null,
        [...outcome.failureSignatureIds].sort(compareText)
    ]);
}

function compareRouteObservations(
    left: FleetGeographyRouteObservation,
    right: FleetGeographyRouteObservation
): number {
    return (left.atEpochMs ?? -1) - (right.atEpochMs ?? -1) ||
        compareText(left.sourceAgentId, right.sourceAgentId) ||
        compareText(left.targetAgentId, right.targetAgentId) ||
        compareText(left.transport ?? '', right.transport ?? '') ||
        Number(left.failed) - Number(right.failed);
}

function dominantFailure(
    failures: ReadonlyMap<string, number>
): string | undefined {
    return [...failures.entries()].sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))[0]?.[0];
}

function isFailedOutcome(outcome: ControlFleetAgentRunOutcome): boolean {
    return outcome.state === 'failed' || outcome.state === 'timed-out';
}

function isMissingOutcome(outcome: ControlFleetAgentRunOutcome): boolean {
    return outcome.missing || outcome.state === 'missing';
}

function locationRank(location: FleetGeographyLocation): number {
    return location.source === 'historical-explicit'
        ? 0
        : location.source === 'historical-datacenter-lookup'
        ? 1
        : 2;
}

function maxDefined(
    left: number | undefined,
    right: number | undefined
): number | undefined {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    return Math.max(left, right);
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : undefined;
}

function stringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.flatMap((entry) => {
            const normalized = stringValue(entry);
            return normalized ? [normalized] : [];
        })
        : [];
}

function uniqueSortedStrings(
    values: readonly (string | undefined)[]
): readonly string[] {
    return [
        ...new Set(values.flatMap((value) => {
            const normalized = stringValue(value);
            return normalized ? [normalized] : [];
        }))
    ].sort(compareText);
}

function uniqueNormalizedStringsInOrder(
    values: readonly (string | undefined)[]
): readonly string[] {
    const normalized = values.flatMap((value) => {
        const item = stringValue(value);
        return item ? [item] : [];
    });
    return [...new Set(normalized)];
}

function uniqueInOrder(values: readonly string[]): readonly string[] {
    return [...new Set(values)];
}

function normalizedText(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeKey(value: string | undefined): string | undefined {
    return normalizedText(value)?.toLowerCase();
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
