import type {
    BrowserContext,
    Page,
    Route,
} from '@playwright/test';
import type {
    ControlAgentSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type { ControlEventEnvelope } from
    '../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlFleetAgentRunOutcome,
    ControlFleetFailureSignature,
    ControlFleetReportBundle,
    ControlFleetRunReport,
} from '../../../packages/shared-test/rallar-bb-test/fleet-report.ts';
import {
    installRecipeConsoleMonitorFixture,
    MONITOR_CONTROL_RUN_ID,
    MONITOR_DISTRIBUTED_RUN_ID,
    MONITOR_FAILURE_AGENT_ID,
    MONITOR_FAILURE_RECIPE_ID,
} from './recipe-console-monitor-fixture.ts';

export const FLEET_REPORT_ID = MONITOR_DISTRIBUTED_RUN_ID;
export const FLEET_CONTROL_RUN_ID = MONITOR_CONTROL_RUN_ID;
export const FLEET_PRIMARY_AGENT_ID = MONITOR_FAILURE_AGENT_ID;
export const FLEET_PRIMARY_RECIPE_ID = MONITOR_FAILURE_RECIPE_ID;
export const FLEET_PRIMARY_SIGNATURE_ID = 'fleet-signature-route-timeout';
export const FLEET_SELECTED_REGION = 'region-01';
export const FLEET_ALTERNATE_REGION = 'region-00';
export const FLEET_EXPLICIT_ONLY_AGENT_ID =
    'fleet-peer-id-is-not-explicit-route-evidence';
export const FLEET_LONG_BIDI_AGENT_ID =
    'fleet-agent-segment-segment-segment-segment-segment-אבג-مرحبا-終端';

export const FLEET_ROUTE = '/?' + new URLSearchParams({
    provider: 'simulated',
    v: '1',
    experience: 'recipe-console',
    view: 'fleet',
    controlRunId: FLEET_CONTROL_RUN_ID,
    distributedRunId: FLEET_REPORT_ID,
    applicationId: 'rallar-server',
    workspaceId: 'default',
    roomId: 'monitor-group',
    fleetRegion: FLEET_SELECTED_REGION,
    fleetMapLayers: 'live-agents,historical-regions,failures',
}).toString();

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
const BASE_EPOCH_MS = 2_100_000_000_000;
const GROUP = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'monitor-group',
} as const;
const REPORT_COUNT = 14;
const RESOLVED_LIVE_AGENT_COUNT = 48;
const UNRESOLVED_LIVE_AGENT_COUNT = 45;
const RESOLVED_ROUTE_COUNT = 36;
const UNRESOLVED_ROUTE_ENDPOINT_COUNT = 45;

export type RecipeConsoleFleetFixture = Readonly<{
    snapshot: ControlServerSnapshot;
    reports: readonly ControlFleetRunReport[];
    artifact: ControlFleetReportBundle;
    artifactRequestCount(): number;
    rootRequestCount(): number;
    failRootReads(): void;
    holdRootReads(): void;
    recoverRootReads(): void;
    releaseRootReads(): void;
    setFleetCollection(
        mode: 'present' | 'absent' | 'empty' | 'schema-error',
    ): void;
}>;

export async function installRecipeConsoleFleetFixture(
    context: BrowserContext,
    page: Page,
): Promise<RecipeConsoleFleetFixture> {
    const monitor = await installRecipeConsoleMonitorFixture(context);
    const reports = createReports();
    const controlRun = augmentControlRun(monitor.snapshot.runs[0]!);
    const snapshot: ControlServerSnapshot = {
        runs: [controlRun],
        distributedRuns: monitor.snapshot.distributedRuns,
        fleetReports: reports,
    };
    const artifact = createArtifact(reports[0]!);
    let rootReads = 0;
    let artifactReads = 0;
    let rootReadsFail = false;
    let heldRootReads: Promise<void> | undefined;
    let releaseHeldRootReads: (() => void) | undefined;
    let collectionMode: 'present' | 'absent' | 'empty' | 'schema-error' =
        'present';

    await page.route(CONTROL_ROUTE, async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'OPTIONS') {
            await route.fulfill({ status: 204, headers: corsHeaders() });
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/runs') {
            rootReads += 1;
            const heldRead = heldRootReads;
            if (heldRead) await heldRead;
            if (rootReadsFail) {
                await route.abort('connectionfailed');
            } else {
                await fulfillJson(
                    route,
                    rootSnapshotForCollection(snapshot, reports, collectionMode),
                );
            }
            return;
        }
        if (
            request.method() === 'GET' &&
            url.pathname === `/runs/${controlRun.runId}`
        ) {
            await fulfillJson(route, controlRun);
            return;
        }
        if (
            request.method() === 'GET' &&
            url.pathname === `/fleet/reports/${FLEET_REPORT_ID}/artifacts`
        ) {
            artifactReads += 1;
            await fulfillJson(route, artifact);
            return;
        }
        await route.fallback();
    });

    return {
        snapshot,
        reports,
        artifact,
        artifactRequestCount: () => artifactReads,
        rootRequestCount: () => rootReads,
        failRootReads: () => { rootReadsFail = true; },
        holdRootReads: () => {
            if (heldRootReads) return;
            heldRootReads = new Promise<void>(resolve => {
                releaseHeldRootReads = resolve;
            });
        },
        recoverRootReads: () => { rootReadsFail = false; },
        releaseRootReads: () => {
            const release = releaseHeldRootReads;
            heldRootReads = undefined;
            releaseHeldRootReads = undefined;
            release?.();
        },
        setFleetCollection: mode => { collectionMode = mode; },
    };
}

function rootSnapshotForCollection(
    snapshot: ControlServerSnapshot,
    reports: readonly ControlFleetRunReport[],
    mode: 'present' | 'absent' | 'empty' | 'schema-error',
): unknown {
    if (mode === 'absent') {
        const { fleetReports: _fleetReports, ...core } = snapshot;
        return core;
    }
    if (mode === 'empty') return { ...snapshot, fleetReports: [] };
    if (mode === 'schema-error') {
        return {
            ...snapshot,
            fleetReports: [...reports, {
                fleetReportSchemaVersion: 999,
                distributedRunId: 'fleet-quarantined-report',
            }],
        };
    }
    return snapshot;
}

function augmentControlRun(base: ControlRunSnapshot): ControlRunSnapshot {
    const baseAgents = base.agents.map((agent, index) => ({
        ...agent,
        identity: {
            ...agent.identity,
            ...GROUP,
            providerMode: 'browser-rallar',
            region: index === 0 ? 'region-00' : FLEET_SELECTED_REGION,
            provider: `fleet-live-provider-${index}`,
            location: location(index),
        },
    }));
    const resolvedIds = Array.from(
        { length: RESOLVED_LIVE_AGENT_COUNT },
        (_, index) => index === RESOLVED_LIVE_AGENT_COUNT - 1
            ? FLEET_LONG_BIDI_AGENT_ID
            : `fleet-live-resolved-${pad(index)}`,
    );
    const resolvedAgents = resolvedIds.map((agentId, index) =>
        controlAgent(agentId, index, true)
    );
    const unresolvedAgents = Array.from(
        { length: UNRESOLVED_LIVE_AGENT_COUNT },
        (_, index) => controlAgent(
            `fleet-live-unresolved-${pad(index)}`,
            index,
            false,
        ),
    );
    const routes = createRouteEvents([
        ...baseAgents.map(agent => agent.agentId),
        ...resolvedIds,
    ]);
    return {
        ...base,
        updatedAtEpochMs: BASE_EPOCH_MS + 9_000,
        agents: [...baseAgents, ...resolvedAgents, ...unresolvedAgents],
        events: [...base.events, ...routes],
    };
}

function controlAgent(
    agentId: string,
    index: number,
    resolved: boolean,
): ControlAgentSnapshot {
    return {
        runId: FLEET_CONTROL_RUN_ID,
        agentId,
        connected: index % 7 !== 0,
        registeredAtEpochMs: BASE_EPOCH_MS - 10_000,
        lastSeenAtEpochMs: BASE_EPOCH_MS + 8_000 - index,
        lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 8_000 - index,
        status: index % 7 === 0 ? 'offline' : 'connected',
        identity: {
            principalId: `${agentId}-principal`,
            sessionId: `${agentId}-session`,
            ...GROUP,
            providerMode: 'browser-rallar',
            browserName: 'chromium',
            ...(resolved ? {
                region: `region-${pad(index % 30)}`,
                provider: `fleet-live-provider-${index % 6}`,
                location: location(index + 2),
            } : {
                region: `undocumented-region-${pad(index)}`,
                provider: 'unresolved-provider',
            }),
        },
        connectionSequence: 1,
        reconnectCount: index % 4,
        receivedResultCount: index % 8,
        receivedEventCount: index % 11,
        completedCommandIds: [],
        resumeCompletedCommandIds: [],
    };
}

function createRouteEvents(resolvedAgentIds: readonly string[]): readonly ControlEventEnvelope[] {
    const resolved = Array.from(
        { length: RESOLVED_ROUTE_COUNT },
        (_, index): ControlEventEnvelope => ({
            kind: 'event',
            protocolVersion: 1,
            runId: FLEET_CONTROL_RUN_ID,
            agentId: resolvedAgentIds[index]!,
            atEpochMs: BASE_EPOCH_MS + 6_000 + index,
            eventId: `fleet-route-resolved-${pad(index)}`,
            payload: {
                targetAgentId: resolvedAgentIds[index + 1]!,
                transport: index % 2 === 0 ? 'messages.rtc' : 'ws',
                ok: index % 5 !== 0,
            },
        }),
    );
    const unresolved = Array.from(
        { length: UNRESOLVED_ROUTE_ENDPOINT_COUNT },
        (_, index): ControlEventEnvelope => ({
            kind: 'event',
            protocolVersion: 1,
            runId: FLEET_CONTROL_RUN_ID,
            agentId: resolvedAgentIds[0]!,
            atEpochMs: BASE_EPOCH_MS + 7_000 + index,
            eventId: `fleet-route-unresolved-${pad(index)}`,
            payload: {
                targetAgentId: `fleet-route-unresolved-endpoint-${pad(index)}`,
                transport: 'rtc',
                failed: index % 3 === 0,
            },
        }),
    );
    const explicitOnlyGuard: ControlEventEnvelope = {
        kind: 'event',
        protocolVersion: 1,
        runId: FLEET_CONTROL_RUN_ID,
        agentId: resolvedAgentIds[0]!,
        atEpochMs: BASE_EPOCH_MS + 8_000,
        eventId: 'fleet-route-peer-id-only',
        payload: {
            peerId: FLEET_EXPLICIT_ONLY_AGENT_ID,
            transport: 'rtc',
            message: `A peer label alone must not create ${FLEET_EXPLICIT_ONLY_AGENT_ID}`,
        },
    };
    return [...resolved, ...unresolved, explicitOnlyGuard];
}

function createReports(): readonly ControlFleetRunReport[] {
    const selectedOutcomes = createSelectedReportOutcomes();
    return Array.from({ length: REPORT_COUNT }, (_, index) => {
        const selected = index === 0;
        const distributedRunId = selected
            ? FLEET_REPORT_ID
            : `fleet-distributed-${pad(index)}`;
        const outcomes = selected
            ? selectedOutcomes
            : [historicalOutcome({
                agentId: FLEET_PRIMARY_AGENT_ID,
                index,
                region: FLEET_SELECTED_REGION,
                provider: `fleet-repeat-provider-${pad(index)}`,
                failed: index % 3 === 0,
                signatureIds: index % 3 === 0
                    ? [FLEET_PRIMARY_SIGNATURE_ID]
                    : [],
            })];
        const failures = selected ? createFailureSignatures(
            selectedOutcomes.slice(0, 45).map(outcome => outcome.agentId),
        ) : [];
        const recipes = selected
            ? Array.from({ length: 30 }, (_, recipeIndex) =>
                recipeIndex === 0
                    ? FLEET_PRIMARY_RECIPE_ID
                    : `fleet-recipe-${pad(recipeIndex)}`
            )
            : [FLEET_PRIMARY_RECIPE_ID];
        const failed = outcomes.filter(outcome => !outcome.ok).length;
        const missing = outcomes.filter(outcome => outcome.missing).length;
        return {
            fleetReportSchemaVersion: 1,
            distributedRunId,
            controlRunId: FLEET_CONTROL_RUN_ID,
            generatedAtEpochMs: BASE_EPOCH_MS - index * 60_000,
            state: failed > 0 ? 'failed' : 'passed',
            ok: failed === 0,
            group: GROUP,
            recipeIds: recipes,
            runDurationMs: 1_500 + index * 37,
            summary: {
                agents: outcomes.length,
                regions: selected ? 55 : 1,
                passed: outcomes.length - failed - missing,
                failed,
                missing,
                flaky: outcomes.filter(outcome => outcome.flaky).length,
                stale: outcomes.filter(outcome => outcome.stale).length,
                passRate: outcomes.length === 0
                    ? 0
                    : (outcomes.length - failed - missing) / outcomes.length,
                failureGroups: failures.length,
            },
            timing: {
                run: timing(1_500 + index * 37),
                commands: timing(140 + index * 3),
            },
            agents: outcomes,
            regions: [],
            failureSignatures: failures,
            artifactRefs: {
                distributedRun: `/distributed-runs/${distributedRunId}`,
                controlRun: `/runs/${FLEET_CONTROL_RUN_ID}`,
                fleetReport: `/fleet/reports/${distributedRunId}`,
            },
        } satisfies ControlFleetRunReport;
    });
}

function createSelectedReportOutcomes(): readonly ControlFleetAgentRunOutcome[] {
    const baseRegions = Array.from({ length: 30 }, (_, index) =>
        historicalOutcome({
            agentId: index === 1
                ? FLEET_PRIMARY_AGENT_ID
                : `fleet-history-region-${pad(index)}`,
            index,
            region: `region-${pad(index)}`,
            provider: index === 1 ? 'fleet-primary-provider' : `provider-${pad(index)}`,
            failed: index < 30,
            signatureIds: [index === 1
                ? FLEET_PRIMARY_SIGNATURE_ID
                : `fleet-signature-${pad(index)}`],
        })
    );
    const repeatedRegionProviders = Array.from({ length: 25 }, (_, index) =>
        historicalOutcome({
            agentId: `fleet-history-region-01-provider-${pad(index + 1)}`,
            index: index + 30,
            region: FLEET_SELECTED_REGION,
            provider: `fleet-extra-provider-${pad(index + 1)}`,
            failed: index < 15,
            signatureIds: index < 15 ? [`fleet-signature-${pad(index)}`] : [],
        })
    );
    const unlabeled = Array.from({ length: 45 }, (_, index) =>
        historicalOutcome({
            agentId: index === 44
                ? FLEET_LONG_BIDI_AGENT_ID
                : `fleet-history-unlabeled-${pad(index)}`,
            index: index + 55,
            failed: false,
            signatureIds: [],
        })
    );
    return [...baseRegions, ...repeatedRegionProviders, ...unlabeled];
}

function historicalOutcome(input: Readonly<{
    agentId: string;
    index: number;
    region?: string;
    provider?: string;
    failed: boolean;
    signatureIds: readonly string[];
}>): ControlFleetAgentRunOutcome {
    return {
        agentId: input.agentId,
        label: {
            agentId: input.agentId,
            ...(input.region ? { region: input.region } : {}),
            ...(input.provider ? { provider: input.provider } : {}),
            browserName: input.index % 2 === 0 ? 'chromium' : 'webkit',
            location: location(input.index + 5),
        },
        state: input.failed ? 'failed' : 'passed',
        ok: !input.failed,
        missing: false,
        flaky: input.index % 13 === 0,
        stale: input.index % 17 === 0,
        commandCount: 3,
        failedCommandCount: input.failed ? 1 : 0,
        resultCount: 3,
        eventCount: 2 + input.index % 4,
        diagnosticCount: input.failed ? 1 : 0,
        reconnectCount: input.index % 3,
        durationMs: 120 + input.index * 11,
        lastHeartbeatAtEpochMs: BASE_EPOCH_MS - input.index,
        failureSignatureIds: input.signatureIds,
    };
}

function createFailureSignatures(
    affectedAgents: readonly string[],
): readonly ControlFleetFailureSignature[] {
    const primary: ControlFleetFailureSignature = {
        signatureId: FLEET_PRIMARY_SIGNATURE_ID,
        category: 'runtime',
        title: 'Observed route acknowledgement timeout',
        normalizedMessage: 'Route acknowledgement did not arrive before timeout.',
        code: 'FLEET_ROUTE_ACK_TIMEOUT',
        recipeId: FLEET_PRIMARY_RECIPE_ID,
        transport: 'messages.rtc',
        count: 50,
        firstSeenAtEpochMs: BASE_EPOCH_MS - 2_000,
        lastSeenAtEpochMs: BASE_EPOCH_MS - 100,
        affectedAgents,
        affectedRegions: [FLEET_SELECTED_REGION],
        affectedRuns: [FLEET_REPORT_ID],
        likelyCause: 'One receiver stopped acknowledging the explicit route.',
        nextAction: 'Open the proving run and inspect the receiver evidence.',
    };
    const additional = Array.from({ length: 29 }, (_, index) => ({
        signatureId: `fleet-signature-${pad(index)}`,
        category: 'command' as const,
        title: `Bounded repeated failure ${pad(index)}`,
        normalizedMessage: `Deterministic failure family ${pad(index)}.`,
        code: `FLEET_FAILURE_${pad(index)}`,
        recipeId: `fleet-recipe-${pad((index % 29) + 1)}`,
        count: 29 - index,
        affectedAgents: [affectedAgents[index % affectedAgents.length]!],
        affectedRegions: [`region-${pad(index % 30)}`],
        affectedRuns: [FLEET_REPORT_ID],
        likelyCause: 'A deterministic fixture condition repeated.',
        nextAction: 'Inspect the exact run and agent before changing the recipe.',
    } satisfies ControlFleetFailureSignature));
    return [primary, ...additional];
}

function createArtifact(report: ControlFleetRunReport): ControlFleetReportBundle {
    return {
        fleetReportSchemaVersion: 1,
        distributedRunId: report.distributedRunId,
        generatedAtEpochMs: report.generatedAtEpochMs,
        files: {
            'fleet-report.json': JSON.stringify(report),
            'summary.md': '# Deterministic Fleet report\n\nValidated root-snapshot evidence.\n',
            'agent-results.csv': 'agentId,state\nmonitor-agent-receiver,failed\n',
            'failure-signatures.csv':
                `signatureId,count\n${FLEET_PRIMARY_SIGNATURE_ID},50\n`,
        },
    };
}

function timing(value: number) {
    return {
        count: 1,
        minMs: value,
        p50Ms: value,
        p90Ms: value,
        p95Ms: value,
        maxMs: value,
    } as const;
}

function location(index: number) {
    return {
        latitude: -58 + (index * 7) % 116,
        longitude: -170 + (index * 13) % 340,
        label: `Fixture location ${index}`,
        precision: 'exact' as const,
    };
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
    await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify(body),
    });
}

function corsHeaders(): Record<string, string> {
    return {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers':
            'authorization, content-type, x-client-id',
    };
}
