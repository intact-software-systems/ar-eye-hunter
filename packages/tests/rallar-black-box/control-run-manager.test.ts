import { describe, expect, it } from 'vitest';
import {
    ControlRunManagerHttpError as ReexportedControlRunManagerHttpError,
    controlHttpBaseUrlFromWsUrl,
    controlRunAgentRows,
    controlRunCommandRows,
    controlRunManagerStats,
    createDistributedRun,
    enqueueBulkControlCommand,
    fetchDistributedRun,
    fetchDistributedRunArtifactBundle,
    fetchDistributedRuns,
    fetchFleetReport,
    fetchFleetReportBundle,
    fetchFleetReports,
    fetchControlRunArtifactBundle,
    fetchControlRunFailureBundle,
    fetchControlRunJsonl,
    fetchControlRunSnapshot,
    fetchControlServerSnapshot,
    rebuildFleetReports,
    resolveDistributedTargets,
    stageDistributedRun,
    startDistributedRun,
    cancelDistributedRun,
    type ControlRunSnapshot,
    type ControlServerSnapshot,
} from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import {
    ControlRunManagerHttpError as CanonicalControlRunManagerHttpError,
} from '../../../apps/rallar-black-box/src/control-http-error.ts';
import { RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION } from '../../../packages/shared-test/rallar-bb-test/control-protocol.ts';

const runSnapshot: ControlRunSnapshot = {
    runId: 'run-1',
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 2_000,
    agents: [
        {
            runId: 'run-1',
            agentId: 'agent-b',
            connected: false,
            connectionSequence: 1,
            reconnectCount: 0,
            receivedResultCount: 0,
            receivedEventCount: 1,
            completedCommandIds: [],
            resumeCompletedCommandIds: [],
        },
        {
            runId: 'run-1',
            agentId: 'agent-a',
            connected: true,
            lastHeartbeatAtEpochMs: 1_900,
            status: 'running',
            identity: {
                principalId: 'alice',
                sessionId: 'session-1',
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group',
            },
            connectionSequence: 2,
            reconnectCount: 1,
            receivedResultCount: 1,
            receivedEventCount: 2,
            completedCommandIds: ['cmd-1'],
            resumeCompletedCommandIds: [],
        },
    ],
    commands: [
        {
            envelope: {
                kind: 'command',
                protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
                runId: 'run-1',
                agentId: 'agent-a',
                commandId: 'cmd-1',
                command: { kind: 'health' },
            },
            queuedAtEpochMs: 1_200,
            dispatchedAtEpochMs: 1_300,
            completedAtEpochMs: 1_400,
            dispatchCount: 1,
        },
        {
            envelope: {
                kind: 'command',
                protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
                runId: 'run-1',
                agentId: 'agent-b',
                commandId: 'cmd-2',
                command: { kind: 'stats' },
            },
            queuedAtEpochMs: 1_500,
            dispatchCount: 0,
        },
    ],
    results: [
        {
            kind: 'result',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: 'run-1',
            agentId: 'agent-a',
            commandId: 'cmd-1',
            ok: true,
        },
    ],
    events: [
        {
            kind: 'diagnostic',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: 'run-1',
            agentId: 'agent-a',
            atEpochMs: 1_600,
            payload: { topic: 'rallar.bb.control.command_received' },
        },
    ],
    stats: [],
    reports: [],
    heartbeats: [],
};

describe('rallar-black-box control run manager', () => {
    it('preserves the canonical HTTP error identity through the manager export', () => {
        expect(ReexportedControlRunManagerHttpError).toBe(
            CanonicalControlRunManagerHttpError,
        );

        const error = new CanonicalControlRunManagerHttpError(
            'Operator token required.',
            401,
            'Unauthorized',
        );

        expect(error).toBeInstanceOf(CanonicalControlRunManagerHttpError);
        expect(error).toBeInstanceOf(ReexportedControlRunManagerHttpError);
        expect(error).toMatchObject({
            name: 'ControlRunManagerHttpError',
            message: 'Operator token required.',
            status: 401,
            statusText: 'Unauthorized',
        });
    });

    it('derives HTTP base URLs from control WebSocket URLs', () => {
        expect(controlHttpBaseUrlFromWsUrl('ws://localhost:5180/control')).toBe('http://localhost:5180');
        expect(controlHttpBaseUrlFromWsUrl('wss://example.test/control?token=secret')).toBe('https://example.test');
        expect(controlHttpBaseUrlFromWsUrl(undefined)).toBe('http://localhost:5180');
    });

    it('summarizes snapshots and derives sorted agent and command rows', () => {
        const snapshot: ControlServerSnapshot = { runs: [runSnapshot] };

        expect(controlRunManagerStats(snapshot)).toMatchObject({
            runCount: 1,
            agentCount: 2,
            connectedAgentCount: 1,
            queuedCommandCount: 1,
            completedCommandCount: 1,
            resultCount: 1,
            eventCount: 1,
        });
        expect(controlRunAgentRows(runSnapshot).map(row => row.agentId)).toEqual(['agent-a', 'agent-b']);
        expect(controlRunAgentRows(runSnapshot)[0].identitySummary).toContain('alice');
        expect(controlRunAgentRows(runSnapshot)[0].identitySummary).toContain('group bb-group');
        expect(controlRunCommandRows(runSnapshot).map(row => [row.commandId, row.status])).toEqual([
            ['cmd-2', 'queued'],
            ['cmd-1', 'completed'],
        ]);
    });

    it('fetches bounded snapshots and enqueues bulk commands', async () => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = String(input);
            requests.push({ url, init });
            if (url.includes('/runs/run-1/commands')) {
                return new Response(JSON.stringify({
                    accepted: true,
                    commands: [],
                }), { status: 202 });
            }
            if (url.includes('/runs/run-1/artifacts')) {
                return new Response(JSON.stringify({
                    artifactSchemaVersion: 1,
                    runId: 'run-1',
                    generatedAtEpochMs: 2_000,
                    files: {
                        'report.json': '{}',
                        'events.jsonl': '',
                        'failures.json': '{}',
                        'metadata.json': '{}',
                    },
                }), { status: 200 });
            }
            if (url.includes('/runs/run-1/events.jsonl')) {
                return new Response('{"kind":"step-result"}\n', { status: 200 });
            }
            if (url.includes('/runs/run-1/failure-bundle')) {
                return new Response(JSON.stringify({ failures: [] }), { status: 200 });
            }
            if (url.includes('/runs/run-1')) {
                return new Response(JSON.stringify(runSnapshot), { status: 200 });
            }
            return new Response(JSON.stringify({ runs: [runSnapshot] }), { status: 200 });
        };

        await fetchControlServerSnapshot({
            baseUrl: 'http://control.test',
            token: 'run-token',
            bounds: { commands: 5, events: 10 },
            fetchFn,
        });
        await fetchControlRunSnapshot({
            baseUrl: 'http://control.test',
            runId: 'run-1',
            bounds: { results: 3 },
            fetchFn,
        });
        await enqueueBulkControlCommand({
            baseUrl: 'http://control.test',
            runId: 'run-1',
            agentIds: ['agent-a', 'agent-b'],
            command: { kind: 'health' },
            commandIdPrefix: 'health-bulk',
            token: 'admin-token',
            fetchFn,
        });
        const artifact = await fetchControlRunArtifactBundle({
            baseUrl: 'http://control.test',
            runId: 'run-1',
            fetchFn,
        });
        const eventsJsonl = await fetchControlRunJsonl({
            baseUrl: 'http://control.test',
            runId: 'run-1',
            kind: 'events',
            fetchFn,
        });
        const failureBundle = await fetchControlRunFailureBundle({
            baseUrl: 'http://control.test',
            runId: 'run-1',
            fetchFn,
        });

        expect(requests[0].url).toContain('/runs?limitCommands=5&limitEvents=10');
        expect((requests[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer run-token');
        expect(requests[1].url).toContain('/runs/run-1?limitResults=3');
        expect(requests[2].url).toBe('http://control.test/runs/run-1/commands');
        expect(requests[2].init?.method).toBe('POST');
        expect(JSON.parse(String(requests[2].init?.body))).toMatchObject({
            agentIds: ['agent-a', 'agent-b'],
            commandIdPrefix: 'health-bulk',
            command: { kind: 'health' },
        });
        expect(artifact.files['report.json']).toBe('{}');
        expect(eventsJsonl).toContain('step-result');
        expect(failureBundle).toEqual({ failures: [] });
    });

    it('preserves response status on HTTP errors without changing the server message', async () => {
        const request = fetchControlServerSnapshot({
            baseUrl: 'http://control.test',
            fetchFn: async () => Response.json(
                { error: 'Operator token required.' },
                { status: 401, statusText: 'Unauthorized' },
            ),
        });

        await expect(request).rejects.toMatchObject({
            name: 'ControlRunManagerHttpError',
            message: 'Operator token required.',
            status: 401,
            statusText: 'Unauthorized',
        });
        await expect(request).rejects.toBeInstanceOf(
            ReexportedControlRunManagerHttpError,
        );
        await expect(request).rejects.toBeInstanceOf(
            CanonicalControlRunManagerHttpError,
        );
    });

    it('calls distributed-run lifecycle endpoints', async () => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const distributedRun = {
            distributedRunId: 'dist-1',
            controlRunId: 'run-1',
            manifest: {
                schemaVersion: 1,
                distributedRunId: 'dist-1',
                controlRunId: 'run-1',
                group: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'bb-group',
                },
                recipes: [
                    {
                        recipeId: 'health-only',
                        recipe: {
                            recipeId: 'health-only',
                            commands: [{ kind: 'health' }],
                        },
                    },
                ],
                targetPolicy: {
                    mode: 'selected-agents',
                    agentIds: ['agent-a'],
                },
            },
            state: 'draft',
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 1_000,
            targetAgentIds: ['agent-a'],
            commandLinks: [],
            rollup: {
                state: 'draft',
                ok: false,
                summary: {
                    participants: 1,
                    requiredParticipants: 1,
                    readyParticipants: 0,
                    passedParticipants: 0,
                    failedParticipants: 0,
                    recipes: 0,
                    requiredRecipes: 0,
                    passedRecipes: 0,
                    failedRecipes: 0,
                    blockingFailures: 0,
                },
                failures: [],
            },
        };
        const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = String(input);
            requests.push({ url, init });
            if (url.endsWith('/distributed-runs/resolve-targets')) {
                return new Response(JSON.stringify({
                    group: distributedRun.manifest.group,
                    resolvedAtEpochMs: 2_000,
                    staleAfterMs: 30_000,
                    targetPolicyMode: 'all-online-group-members',
                    targetAgentIds: ['agent-a'],
                    roleAssignments: [{ role: 'sender', agentId: 'agent-a', required: true }],
                    blockers: [],
                    summary: {
                        agents: 1,
                        targetable: 1,
                        selected: 1,
                        expectedParticipantCount: 1,
                        missingExpectedParticipants: 0,
                        staleAgents: 0,
                        offlineAgents: 0,
                        wrongGroupAgents: 0,
                        agentsWithoutIdentity: 0,
                        roleCounts: { sender: 1 },
                        regions: {},
                        providers: {},
                    },
                }), { status: 200 });
            }
            if (url.endsWith('/distributed-runs')) {
                if (init?.method === 'POST') {
                    return new Response(JSON.stringify(distributedRun), { status: 201 });
                }
                return new Response(JSON.stringify({ distributedRuns: [distributedRun] }), { status: 200 });
            }
            if (url.endsWith('/stage') || url.endsWith('/start') || url.endsWith('/cancel')) {
                return new Response(JSON.stringify({ ...distributedRun, state: 'running' }), { status: 202 });
            }
            if (url.endsWith('/artifacts')) {
                return new Response(JSON.stringify({
                    artifactSchemaVersion: 1,
                    distributedRunId: 'dist-1',
                    generatedAtEpochMs: 2_000,
                    files: {
                        'distributed-run.json': '{}',
                        'manifest.json': '{}',
                        'control-run.json': '{}',
                    },
                }), { status: 200 });
            }
            return new Response(JSON.stringify(distributedRun), { status: 200 });
        };

        await fetchDistributedRuns({ baseUrl: 'http://control.test', token: 'admin-token', fetchFn });
        await fetchDistributedRun({
            baseUrl: 'http://control.test',
            distributedRunId: 'dist-1',
            fetchFn,
        });
        const targetResolution = await resolveDistributedTargets({
            baseUrl: 'http://control.test',
            token: 'admin-token',
            manifest: {
                ...distributedRun.manifest,
                targetPolicy: {
                    mode: 'all-online-group-members',
                    expectedParticipantCount: 1,
                },
                roleAssignmentPolicy: {
                    mode: 'ordered-targets',
                    pattern: 'one-sender-many-receivers',
                    orderBy: 'agent-id',
                },
            },
            fetchFn,
        });
        await createDistributedRun({
            baseUrl: 'http://control.test',
            token: 'admin-token',
            manifest: distributedRun.manifest,
            fetchFn,
        });
        await stageDistributedRun({ baseUrl: 'http://control.test', distributedRunId: 'dist-1', fetchFn });
        await startDistributedRun({ baseUrl: 'http://control.test', distributedRunId: 'dist-1', fetchFn });
        await cancelDistributedRun({
            baseUrl: 'http://control.test',
            distributedRunId: 'dist-1',
            reason: 'stop',
            fetchFn,
        });
        const artifact = await fetchDistributedRunArtifactBundle({
            baseUrl: 'http://control.test',
            distributedRunId: 'dist-1',
            fetchFn,
        });

        expect(requests.map(request => request.url)).toEqual([
            'http://control.test/distributed-runs',
            'http://control.test/distributed-runs/dist-1',
            'http://control.test/distributed-runs/resolve-targets',
            'http://control.test/distributed-runs',
            'http://control.test/distributed-runs/dist-1/stage',
            'http://control.test/distributed-runs/dist-1/start',
            'http://control.test/distributed-runs/dist-1/cancel',
            'http://control.test/distributed-runs/dist-1/artifacts',
        ]);
        expect(JSON.parse(String(requests[2].init?.body))).toEqual({
            manifest: {
                ...distributedRun.manifest,
                targetPolicy: {
                    mode: 'all-online-group-members',
                    expectedParticipantCount: 1,
                },
                roleAssignmentPolicy: {
                    mode: 'ordered-targets',
                    pattern: 'one-sender-many-receivers',
                    orderBy: 'agent-id',
                },
            },
        });
        expect(JSON.parse(String(requests[3].init?.body))).toEqual({
            manifest: distributedRun.manifest,
        });
        expect(JSON.parse(String(requests[6].init?.body))).toEqual({ reason: 'stop' });
        expect((requests[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer admin-token');
        expect((requests[2].init?.headers as Record<string, string>).Authorization).toBe('Bearer admin-token');
        expect(targetResolution.summary.roleCounts).toEqual({ sender: 1 });
        expect(artifact.files['manifest.json']).toBe('{}');
    });

    it('calls fleet report endpoints with filters and export helpers', async () => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const report = {
            fleetReportSchemaVersion: 1,
            distributedRunId: 'dist-1',
            controlRunId: 'run-1',
            generatedAtEpochMs: 2_000,
            state: 'failed',
            ok: false,
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group',
            },
            recipeIds: ['health-only'],
            summary: {
                agents: 2,
                regions: 1,
                passed: 1,
                failed: 1,
                missing: 0,
                flaky: 0,
                stale: 0,
                passRate: 0.5,
                failureGroups: 1,
            },
            timing: {
                run: { count: 1, p95Ms: 25 },
                commands: { count: 2, p95Ms: 10 },
            },
            agents: [],
            regions: [],
            failureSignatures: [],
            artifactRefs: {
                distributedRun: 'distributed-run:dist-1',
                controlRun: 'control-run:run-1',
                fleetReport: 'fleet-report:dist-1',
            },
        };
        const response = {
            reports: [report],
            aggregate: {
                generatedAtEpochMs: 2_000,
                reportCount: 1,
                runCount: 1,
                agentCount: 2,
                regionCount: 1,
                passRate: 0.5,
                staleAgentCount: 0,
                flakyAgentCount: 0,
                failureGroupCount: 1,
                timing: {
                    runs: { count: 1, p95Ms: 25 },
                    commands: { count: 2, p95Ms: 10 },
                },
                regions: [],
                failureSignatures: [],
            },
        };
        const bundle = {
            fleetReportSchemaVersion: 1,
            distributedRunId: 'dist-1',
            generatedAtEpochMs: 2_100,
            files: {
                'fleet-report.json': '{}',
                'summary.md': '# Fleet Run Report',
                'agent-results.csv': 'agentId',
                'failure-signatures.csv': 'signatureId',
            },
        };
        const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = String(input);
            requests.push({ url, init });
            if (url.endsWith('/fleet/reports/rebuild')) {
                return new Response(JSON.stringify(response), { status: 200 });
            }
            if (url.endsWith('/fleet/reports/dist-1/artifacts')) {
                return new Response(JSON.stringify(bundle), { status: 200 });
            }
            if (url.endsWith('/fleet/reports/dist-1')) {
                return new Response(JSON.stringify(report), { status: 200 });
            }
            return new Response(JSON.stringify(response), { status: 200 });
        };

        const reports = await fetchFleetReports({
            baseUrl: 'http://control.test',
            token: 'admin-token',
            filter: {
                region: 'eu-north',
                provider: 'hetzner',
                recipeId: 'health-only',
                groupId: 'bb-group',
                state: 'failed',
                fromEpochMs: 1_000,
                toEpochMs: 3_000,
            },
            fetchFn,
        });
        const singleReport = await fetchFleetReport({
            baseUrl: 'http://control.test',
            distributedRunId: 'dist-1',
            fetchFn,
        });
        const exportBundle = await fetchFleetReportBundle({
            baseUrl: 'http://control.test',
            distributedRunId: 'dist-1',
            fetchFn,
        });
        await rebuildFleetReports({
            baseUrl: 'http://control.test',
            token: 'admin-token',
            fetchFn,
        });

        expect(requests[0].url).toBe(
            'http://control.test/fleet/reports?region=eu-north&provider=hetzner&recipeId=health-only&groupId=bb-group&state=failed&fromEpochMs=1000&toEpochMs=3000',
        );
        expect((requests[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer admin-token');
        expect(requests[1].url).toBe('http://control.test/fleet/reports/dist-1');
        expect(requests[2].url).toBe('http://control.test/fleet/reports/dist-1/artifacts');
        expect(requests[3].url).toBe('http://control.test/fleet/reports/rebuild');
        expect(requests[3].init?.method).toBe('POST');
        expect(reports.aggregate.agentCount).toBe(2);
        expect(singleReport.distributedRunId).toBe('dist-1');
        expect(exportBundle.files['summary.md']).toContain('Fleet Run Report');
    });
});
