import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES } from '@shared-test/rallar-bb-test/control-protocol.ts';

import { registerAgent, waitForSocketOpen } from './support/control-api-test-agent.ts';
import { ADMIN_TOKEN, adminHeaders, canBindLoopback, getJson, startControlServer } from './support/control-api-test-server.ts';
import { toDistributedManifest } from './support/control-service-test-fixtures.ts';

test('retention preview is authorized, non-destructive, and guarded before cleanup', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-retention-api-'));
    const snapshotPath = `${storageDir}/control-snapshot.json`;
    const run = (runId: string, updatedAtEpochMs: number) => ({
        runId,
        createdAtEpochMs: updatedAtEpochMs,
        updatedAtEpochMs,
        agents: [],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: []
    });
    await writeFile(
        snapshotPath,
        JSON.stringify({
            schemaVersion: 1,
            savedAtEpochMs: 3_000,
            snapshot: {
                runs: [run('retention-old', 1_000), run('retention-new', 2_000)],
                distributedRuns: [{
                    distributedRunId: 'retention-dist-old',
                    controlRunId: 'retention-old',
                    manifest: toDistributedManifest({
                        distributedRunId: 'retention-dist-old',
                        controlRunId: 'retention-old',
                        group: {
                            applicationId: 'rallar-server',
                            workspaceId: 'default',
                            groupId: 'retention-group'
                        }
                    }),
                    state: 'failed',
                    createdAtEpochMs: 1_000,
                    updatedAtEpochMs: 1_000,
                    targetAgentIds: [],
                    commandLinks: [],
                    rollup: {
                        state: 'failed',
                        ok: false,
                        summary: {
                            participants: 0,
                            readyParticipants: 0,
                            passedParticipants: 0,
                            failedParticipants: 0,
                            recipes: 0,
                            passedRecipes: 0,
                            failedRecipes: 0,
                            groupAssertions: 0,
                            passedGroupAssertions: 0,
                            failedGroupAssertions: 0,
                            blockingFailures: 0
                        },
                        failures: []
                    }
                }],
                fleetReports: [{
                    fleetReportSchemaVersion: 1,
                    distributedRunId: 'retention-dist-old',
                    controlRunId: 'retention-old',
                    generatedAtEpochMs: 2_000,
                    state: 'failed',
                    ok: false,
                    group: {
                        applicationId: 'rallar-server',
                        workspaceId: 'default',
                        groupId: 'retention-group'
                    },
                    recipeIds: [],
                    summary: {
                        agents: 0,
                        regions: 0,
                        passed: 0,
                        failed: 1,
                        missing: 0,
                        flaky: 0,
                        stale: 0,
                        passRate: 0,
                        failureGroups: 1
                    },
                    timing: { run: { count: 0 }, commands: { count: 0 } },
                    agents: [],
                    regions: [],
                    failureSignatures: [],
                    artifactRefs: {
                        distributedRun: '/distributed-runs/retention-dist-old',
                        controlRun: '/runs/retention-old',
                        fleetReport: '/fleet/reports/retention-dist-old'
                    }
                }]
            }
        })
    );
    const artifactDir = `${storageDir}/runs/retention-old`;
    const artifactPath = `${artifactDir}/sentinel.jsonl`;
    await mkdir(artifactDir, { recursive: true });
    await writeFile(artifactPath, 'manual-cleanup-must-preserve-this\n', 'utf8');
    const beforePreview = await readFile(snapshotPath, 'utf8');
    const server = await startControlServer({
        RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
        RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: '1',
        RALLAR_BLACK_BOX_STORAGE_DIR: storageDir
    });
    let unregisteredSocket: WebSocket | undefined;
    try {
        unregisteredSocket = new WebSocket(
            `${server.baseUrl.replace(/^http/, 'ws')}/control`
        );
        await waitForSocketOpen(unregisteredSocket);
        const unauthorizedBody = { error: 'Admin token is required or invalid.' };
        for (
            const query of [
                '?dryRun=true',
                '?dryRun=false',
                '?dryRun=true&dryRun=true',
                '?planToken=v1.abc.def',
                '?planToken=v1.abc.def&planToken=v1.abc.def',
                '?dryRun=true&planToken=v1.abc.def',
                `?planToken=${'a'.repeat(513)}`,
                '?planToken=v1.abc.def&token=v1.abc.def'
            ]
        ) {
            const unauthorized = await fetch(
                `${server.baseUrl}/retention/cleanup${query}`,
                {
                    method: 'POST'
                }
            );
            expect(unauthorized.status).toEqual(401);
            expect(await unauthorized.json()).toEqual(unauthorizedBody);
        }

        for (
            const query of [
                '?dryRun=false',
                '?dryRun=',
                '?dryRun=true&dryRun=true',
                '?planToken=',
                '?planToken=v1.abc.def&planToken=v1.abc.def',
                '?dryRun=true&planToken=v1.abc.def',
                `?planToken=${'a'.repeat(513)}`
            ]
        ) {
            const invalid = await fetch(
                `${server.baseUrl}/retention/cleanup${query}`,
                {
                    method: 'POST',
                    headers: adminHeaders()
                }
            );
            expect(invalid.status).toEqual(400);
        }

        const previewResponse = await fetch(
            `${server.baseUrl}/retention/cleanup?dryRun=true`,
            {
                method: 'POST',
                headers: adminHeaders(),
                body: `{ malformed and intentionally larger than the request body limit ${'x'.repeat(RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES)}`
            }
        );
        expect(previewResponse.status).toEqual(200);
        const preview = await previewResponse.json() as {
            dryRun?: boolean;
            deletedRunIds?: readonly string[];
            retainedRuns?: number;
            projectedRetainedRuns?: number;
            maxRuns?: number;
            wouldDeleteRuns?: readonly {
                runId: string;
                createdAtEpochMs: number;
                updatedAtEpochMs: number;
                connectedAgentCount: number;
                issuedRunTokenCount: number;
                distributedRuns: readonly object[];
                fleetReportIds: readonly string[];
            }[];
            wouldDeleteRunIds?: readonly string[];
            wouldDeleteDistributedRunIds?: readonly string[];
            wouldDeleteFleetReportIds?: readonly string[];
            preserves?: {
                connectedAgentSockets?: boolean;
                storedArtifactFiles?: boolean;
            };
            planToken?: string;
        };
        expect(preview.dryRun).toEqual(true);
        expect(preview.deletedRunIds).toEqual([]);
        expect(preview.retainedRuns).toEqual(2);
        expect(preview.projectedRetainedRuns).toEqual(1);
        expect(preview.maxRuns).toEqual(1);
        expect(preview.wouldDeleteRuns).toEqual([{
            runId: 'retention-old',
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 1_000,
            connectedAgentCount: 0,
            issuedRunTokenCount: 0,
            distributedRuns: [{
                distributedRunId: 'retention-dist-old',
                state: 'failed'
            }],
            fleetReportIds: ['retention-dist-old']
        }]);
        expect(preview.wouldDeleteRunIds).toEqual(['retention-old']);
        expect(preview.wouldDeleteDistributedRunIds).toEqual(['retention-dist-old']);
        expect(preview.wouldDeleteFleetReportIds).toEqual(['retention-dist-old']);
        expect(preview.preserves).toEqual({
            connectedAgentSockets: true,
            storedArtifactFiles: true
        });
        assert(typeof preview.planToken === 'string' && preview.planToken.length > 0);
        assert(!JSON.stringify(preview).includes('revision:'));
        assert(!JSON.stringify(preview).includes('canonicalConsequence'));
        expect(await readFile(snapshotPath, 'utf8')).toEqual(beforePreview);
        expect(await readFile(artifactPath, 'utf8')).toEqual('manual-cleanup-must-preserve-this\n');
        expect(unregisteredSocket.readyState).toEqual(WebSocket.OPEN);
        expect(
            (await getJson<{ runs: readonly object[]; }>(server.baseUrl, '/runs')).runs
                .length
        ).toEqual(2);

        const tamperedToken = `${preview.planToken.slice(0, -1)}${preview.planToken.endsWith('A') ? 'B' : 'A'}`;
        const staleBody = {
            error: 'Retention preview is stale, expired, or belongs to another server process.'
        };
        const tampered = await fetch(
            `${server.baseUrl}/retention/cleanup?planToken=${encodeURIComponent(tamperedToken)}`,
            { method: 'POST', headers: adminHeaders() }
        );
        expect(tampered.status).toEqual(409);
        expect(await tampered.json()).toEqual(staleBody);
        expect(
            (await getJson<{ runs: readonly object[]; }>(server.baseUrl, '/runs')).runs
                .length
        ).toEqual(2);

        const unauthorizedIssuedToken = await fetch(
            `${server.baseUrl}/retention/cleanup?planToken=${encodeURIComponent(preview.planToken)}`,
            { method: 'POST' }
        );
        expect(unauthorizedIssuedToken.status).toEqual(401);
        expect(await unauthorizedIssuedToken.json()).toEqual(unauthorizedBody);

        const otherStorageDir = await mkdtemp(join(tmpdir(), 'rallar-retention-other-'));
        await writeFile(`${otherStorageDir}/control-snapshot.json`, beforePreview, 'utf8');
        const otherServer = await startControlServer({
            RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
            RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: '1',
            RALLAR_BLACK_BOX_STORAGE_DIR: otherStorageDir
        });
        try {
            const wrongProcess = await fetch(
                `${otherServer.baseUrl}/retention/cleanup?planToken=${encodeURIComponent(preview.planToken)}`,
                { method: 'POST', headers: adminHeaders() }
            );
            expect(wrongProcess.status).toEqual(409);
            expect(await wrongProcess.json()).toEqual(staleBody);
            expect(
                (await getJson<{ runs: readonly object[]; }>(
                    otherServer.baseUrl,
                    '/runs'
                )).runs.length
            ).toEqual(2);
        }
        finally {
            await otherServer.stop();
            await rm(otherStorageDir, { recursive: true, force: true });
        }

        const confirmResponse = await fetch(
            `${server.baseUrl}/retention/cleanup?planToken=${encodeURIComponent(preview.planToken)}`,
            {
                method: 'POST',
                headers: adminHeaders(),
                body: '{ malformed and intentionally larger than the request body limit'
            }
        );
        expect(confirmResponse.status).toEqual(200);
        expect(await confirmResponse.json()).toEqual({
            deletedRunIds: ['retention-old'],
            retainedRuns: 1,
            maxRuns: 1
        });
        expect(await readFile(artifactPath, 'utf8')).toEqual('manual-cleanup-must-preserve-this\n');
        expect(unregisteredSocket.readyState).toEqual(WebSocket.OPEN);
        expect(
            (await getJson<{ distributedRuns: readonly object[]; }>(
                server.baseUrl,
                '/distributed-runs'
            )).distributedRuns.length
        ).toEqual(0);
        expect(
            (await getJson<{ reports: readonly object[]; }>(
                server.baseUrl,
                '/fleet/reports'
            )).reports
                .length
        ).toEqual(0);

        const reused = await fetch(
            `${server.baseUrl}/retention/cleanup?planToken=${encodeURIComponent(preview.planToken)}`,
            { method: 'POST', headers: adminHeaders() }
        );
        expect(reused.status).toEqual(409);
        expect(await reused.json()).toEqual(staleBody);
    }
    finally {
        unregisteredSocket?.close();
        await server.stop();
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('automatic retention past its cap keeps a live run, its socket and its artifact files', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-auto-retention-'));
    const server = await startControlServer({
        RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: '1',
        RALLAR_BLACK_BOX_STORAGE_DIR: storageDir
    });
    let oldSocket: WebSocket | undefined;
    let newSocket: WebSocket | undefined;
    try {
        oldSocket = await registerAgent(server.baseUrl, 'auto-old', 'agent-old');
        const oldArtifactFile = `${storageDir}/runs/auto-old/sentinel.jsonl`;
        await mkdir(`${storageDir}/runs/auto-old`, { recursive: true });
        await writeFile(oldArtifactFile, 'kept-while-live\n', 'utf8');

        newSocket = await registerAgent(server.baseUrl, 'auto-new', 'agent-new');
        const runs = await getJson<{ runs: readonly { runId: string; }[]; }>(
            server.baseUrl,
            '/runs'
        );

        expect(runs.runs.map((entry) => entry.runId).sort()).toEqual(['auto-new', 'auto-old']);
        expect(oldSocket.readyState).toEqual(WebSocket.OPEN);
        expect(newSocket.readyState).toEqual(WebSocket.OPEN);
        expect(await readFile(oldArtifactFile, 'utf8')).toEqual('kept-while-live\n');
    }
    finally {
        oldSocket?.close();
        newSocket?.close();
        await server.stop();
        await rm(storageDir, { recursive: true, force: true });
    }
});
