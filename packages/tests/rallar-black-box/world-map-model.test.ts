import { describe, expect, it } from 'vitest';
import {
    deriveFleetWorldMapModel,
    routeEvidenceFromControlRun,
} from '../../../apps/rallar-black-box/src/world-map-model.ts';
import type {
    ControlAgentBoardRow,
} from '../../../apps/rallar-black-box/src/control-agent-board.ts';
import type {
    ControlRunSnapshot,
} from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import type {
    ControlFleetAgentLabel,
    ControlFleetAgentRunOutcome,
    ControlFleetRunReport,
} from '../../../packages/shared-test/rallar-bb-test/fleet-report.ts';

function liveAgent(
    agentId: string,
    identity: ControlAgentBoardRow['identity'],
    connected = true,
): ControlAgentBoardRow {
    return {
        agentId,
        synthetic: false,
        connected,
        connectionStatus: connected ? 'connected' : 'offline',
        lastSeenAtEpochMs: 4_000,
        lastHeartbeatAtEpochMs: connected ? 4_000 : undefined,
        identity,
        region: identity?.region,
        provider: identity?.provider,
        datacenter: identity?.datacenter,
        tags: identity?.tags ?? [],
        crdtTransports: [],
        targetStatus: connected ? 'matched' : 'offline',
        targetable: connected,
        targetReason: connected ? 'ready' : 'offline',
        queuedCommandCount: 0,
        completedCommandCount: 0,
        receivedResultCount: 0,
        receivedEventCount: 0,
        reconnectCount: 0,
        activeRuns: [],
    };
}

function outcome(
    agentId: string,
    label: ControlFleetAgentLabel,
    state: ControlFleetAgentRunOutcome['state'],
    failureSignatureIds: readonly string[] = [],
): ControlFleetAgentRunOutcome {
    return {
        agentId,
        label,
        state,
        ok: state === 'passed',
        missing: state === 'missing',
        flaky: false,
        stale: false,
        commandCount: 1,
        failedCommandCount: state === 'failed' ? 1 : 0,
        resultCount: 1,
        eventCount: 2,
        diagnosticCount: state === 'failed' ? 1 : 0,
        reconnectCount: 0,
        durationMs: 250,
        lastHeartbeatAtEpochMs: 3_500,
        failureSignatureIds,
    };
}

function report(
    agents: readonly ControlFleetAgentRunOutcome[],
    distributedRunId = 'dist-1',
): ControlFleetRunReport {
    return {
        fleetReportSchemaVersion: 1,
        distributedRunId,
        controlRunId: `control-${distributedRunId}`,
        generatedAtEpochMs: 4_000,
        state: 'failed',
        ok: false,
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group',
        },
        recipeIds: ['rtc-smoke'],
        runDurationMs: 1_000,
        summary: {
            agents: agents.length,
            regions: 2,
            passed: 1,
            failed: 1,
            missing: 1,
            flaky: 0,
            stale: 0,
            passRate: 1 / 3,
            failureGroups: 1,
        },
        timing: {
            run: { count: 1, p50Ms: 1_000, p95Ms: 1_000 },
            commands: { count: 3, p50Ms: 250, p95Ms: 250 },
        },
        agents,
        regions: [],
        failureSignatures: [{
            signatureId: 'sig-runtime',
            category: 'runtime',
            title: 'Runtime failure',
            normalizedMessage: 'runtime failure',
            count: 1,
            affectedAgents: ['agent-2'],
            affectedRegions: ['eu-north'],
            affectedRuns: [distributedRunId],
            likelyCause: 'Agent runtime failed.',
            nextAction: 'Inspect agent logs.',
        }],
        artifactRefs: {
            distributedRun: `distributed-run:${distributedRunId}`,
            controlRun: `control-run:control-${distributedRunId}`,
            fleetReport: `fleet-report:${distributedRunId}`,
        },
    };
}

describe('fleet world map model', () => {
    it('resolves explicit coordinates before datacenter fallbacks and keeps missing agents unresolved', () => {
        const model = deriveFleetWorldMapModel({
            liveAgents: [
                liveAgent('agent-1', {
                    region: 'eu-north',
                    provider: 'hetzner',
                    datacenter: 'fsn1',
                    location: {
                        latitude: 59.9139,
                        longitude: 10.7522,
                        label: 'Oslo operator rack',
                        precision: 'exact',
                    },
                }),
                liveAgent('agent-3', {
                    provider: 'private-lab',
                }),
            ],
            reports: [report([
                outcome('agent-1', {
                    agentId: 'agent-1',
                    region: 'eu-north',
                    provider: 'hetzner',
                    datacenter: 'fsn1',
                }, 'passed'),
                outcome('agent-2', {
                    agentId: 'agent-2',
                    region: 'eu-north',
                    provider: 'hetzner',
                    datacenter: 'hel1',
                }, 'failed', ['sig-runtime']),
                outcome('agent-3', {
                    agentId: 'agent-3',
                    provider: 'private-lab',
                }, 'missing'),
            ])],
            selectedReportId: 'dist-1',
        });

        expect(model.agents.find((agent) => agent.agentId === 'agent-1')?.location).toMatchObject({
            latitude: 59.9139,
            longitude: 10.7522,
            label: 'Oslo operator rack',
            source: 'agent',
        });
        expect(model.agents.find((agent) => agent.agentId === 'agent-2')?.location).toMatchObject({
            source: 'datacenter-lookup',
            precision: 'approximate',
        });
        expect(model.unresolvedAgentIds).toEqual(['agent-3']);
        expect(model.summary.failedAgents).toBe(1);
        expect(model.regions.find((region) => region.region === 'eu-north')?.dominantFailureSignatureId)
            .toBe('sig-runtime');
    });

    it('keeps live agent markers separate from historical report agents', () => {
        const model = deriveFleetWorldMapModel({
            liveAgents: [
                liveAgent('live-agent', {
                    region: 'eu-north',
                    provider: 'hetzner',
                    datacenter: 'fsn1',
                }),
            ],
            reports: [report([
                outcome('historical-agent', {
                    agentId: 'historical-agent',
                    region: 'us-east',
                    provider: 'hetzner',
                    datacenter: 'ash',
                }, 'passed'),
            ])],
        });

        expect(model.agents.map((agent) => agent.agentId)).toEqual([
            'historical-agent',
            'live-agent',
        ]);
        expect(model.liveAgents.map((agent) => agent.agentId)).toEqual([
            'live-agent',
        ]);
        expect(model.historicalAgents.map((agent) => agent.agentId)).toEqual([
            'historical-agent',
        ]);
        expect(model.summary.liveAgents).toBe(1);
    });

    it('keeps historical regions aggregated across all reports when a report is selected', () => {
        const model = deriveFleetWorldMapModel({
            reports: [
                report([
                    outcome('agent-1', {
                        agentId: 'agent-1',
                        region: 'eu-north',
                        provider: 'hetzner',
                        datacenter: 'fsn1',
                    }, 'passed'),
                ], 'dist-1'),
                report([
                    outcome('agent-2', {
                        agentId: 'agent-2',
                        region: 'us-east',
                        provider: 'hetzner',
                        datacenter: 'ash',
                    }, 'failed', ['sig-runtime']),
                ], 'dist-2'),
            ],
            selectedReportId: 'dist-1',
        });

        expect(model.regions.map((region) => region.region).sort()).toEqual([
            'eu-north',
            'us-east',
        ]);
        expect(model.summary.historicalRegions).toBe(2);
    });

    it('suppresses observed routes when either endpoint has no map location', () => {
        const model = deriveFleetWorldMapModel({
            reports: [report([
                outcome('agent-1', {
                    agentId: 'agent-1',
                    region: 'eu-north',
                    provider: 'hetzner',
                    datacenter: 'fsn1',
                }, 'passed'),
                outcome('agent-2', {
                    agentId: 'agent-2',
                    region: 'us-east',
                    provider: 'hetzner',
                    datacenter: 'ash',
                }, 'failed', ['sig-runtime']),
                outcome('agent-3', {
                    agentId: 'agent-3',
                    provider: 'private-lab',
                }, 'missing'),
            ])],
            routeEvidence: [
                {
                    sourceAgentId: 'agent-1',
                    targetAgentId: 'agent-2',
                    atEpochMs: 4_100,
                    transport: 'rtc',
                },
                {
                    sourceAgentId: 'agent-1',
                    targetAgentId: 'agent-2',
                    atEpochMs: 4_200,
                    transport: 'rtc',
                    failed: true,
                },
                {
                    sourceAgentId: 'agent-1',
                    targetAgentId: 'agent-3',
                    atEpochMs: 4_300,
                    transport: 'rtc',
                },
            ],
        });

        expect(model.routes).toHaveLength(1);
        expect(model.routes[0]).toMatchObject({
            sourceAgentId: 'agent-1',
            targetAgentId: 'agent-2',
            eventCount: 2,
            failedCount: 1,
            transport: 'rtc',
            kind: 'observed-route',
        });
        expect(model.summary.routes).toBe(1);
    });

    it('extracts route evidence only from explicit control event target agent fields', () => {
        const evidence = routeEvidenceFromControlRun({
            runId: 'run-1',
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 2_000,
            agents: [],
            commands: [],
            results: [],
            events: [
                {
                    kind: 'event',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-1',
                    atEpochMs: 2_000,
                    payload: {
                        targetAgentId: 'agent-2',
                        transport: 'rtc',
                    },
                },
                {
                    kind: 'diagnostic',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-1',
                    atEpochMs: 2_100,
                    payload: {
                        peerId: 'browser-session-2',
                    },
                },
            ],
            stats: [],
            reports: [],
            heartbeats: [],
        } satisfies ControlRunSnapshot);

        expect(evidence).toEqual([{
            sourceAgentId: 'agent-1',
            targetAgentId: 'agent-2',
            atEpochMs: 2_000,
            transport: 'rtc',
            failed: false,
        }]);
    });
});
