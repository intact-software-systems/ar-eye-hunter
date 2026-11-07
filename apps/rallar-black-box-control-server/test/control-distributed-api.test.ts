import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseControlServerMessage } from '@shared-test/rallar-bb-test/control-protocol.ts';
import {
    decodeControlDistributedRunSnapshot,
    decodeTargetResolution
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import { createRallarBlackBoxRtcSmokeRecipe } from '@shared-test/rallar-bb-test/fixtures/rtc-live-recipes.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { registerAgent, waitForPersistedSnapshot } from './support/control-api-test-agent.ts';
import { distributedManifest } from './support/control-api-test-fixtures.ts';
import {
    ADMIN_TOKEN,
    adminHeaders,
    bearerJsonHeaders,
    canBindLoopback,
    getJson,
    OPERATOR_TOKEN_SECRET,
    operatorToken,
    startControlServer
} from './support/control-api-test-server.ts';
import { assertRight } from './support/control-service-test-fixtures.ts';

test('distributed HTTP stage and unstaged start visibly refuse unsupported required capture', async () => {
    assert(await canBindLoopback());
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-capture-admission-'));
    try {
        const server = await startControlServer({ RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN, RALLAR_BLACK_BOX_STORAGE_DIR: storageDir });
        let socket: WebSocket | undefined;
        try {
            socket = await registerAgent(server.baseUrl, 'api-control-run', 'agent-a');
            for (const phase of ['stage', 'start']) {
                const distributedRunId = `capture-refusal-${phase}`;
                const manifest = {
                    ...distributedManifest(),
                    distributedRunId,
                    rtcCaptureMode: 'native',
                    recipes: [{
                        recipeId: 'rtc-smoke-recipe',
                        recipe: createRallarBlackBoxRtcSmokeRecipe(),
                        variables: {}
                    }]
                };
                const created = await fetch(`${server.baseUrl}/distributed-runs`, {
                    method: 'POST',
                    headers: adminHeaders(),
                    body: JSON.stringify({ manifest })
                });
                expect(created.status).toEqual(201);
                await created.body?.cancel();
                const refused = await fetch(`${server.baseUrl}/distributed-runs/${distributedRunId}/${phase}`, { method: 'POST', headers: adminHeaders() });
                const response: unknown = await refused.json();
                const snapshot = await getJson<unknown>(server.baseUrl, `/distributed-runs/${distributedRunId}`);
                assert(isJsonRecordValue(snapshot));
                expect({
                    refused: refused.status >= 400 || snapshot.state === 'failed',
                    captureReason: JSON.stringify(response).toLowerCase().includes('capture'),
                    links: snapshot.commandLinks
                }).toEqual({
                    refused: true,
                    captureReason: true,
                    links: []
                });
            }
        }
        finally {
            try {
                socket?.close();
            }
            finally {
                await server.stop();
            }
        }
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('distributed HTTP admission retains explicit Off through actual results and serialized export', async () => {
    assert(await canBindLoopback());
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-capture-'));
    try {
        const server = await startControlServer({
            RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
            RALLAR_BLACK_BOX_STORAGE_DIR: storageDir
        });
        let socket: WebSocket | undefined;
        try {
            const manifest: unknown = JSON.parse(
                await readFile(
                    new URL(
                        '../../../packages/shared-test/black-box-runner/fixtures/distributed-run-capture.json',
                        import.meta.url
                    ),
                    'utf8'
                )
            );
            assert(isJsonRecordValue(manifest));
            const agentSocket = await registerAgent(server.baseUrl, 'api-capture-control', 'agent-a');
            socket = agentSocket;
            const runtime = createDefaultRallarBlackBoxTestRuntime();
            const completed = Promise.withResolvers<void>();
            agentSocket.addEventListener('message', (event) => {
                void (async () => {
                    try {
                        const decoded = parseControlServerMessage(event.data, { runId: 'api-capture-control', agentId: 'agent-a' });
                        assert(decoded.ok);
                        const result = await runtime.execute({ ...decoded.envelope.command, commandId: decoded.envelope.commandId });
                        expect(result.ok).toEqual(true);
                        agentSocket.send(JSON.stringify({
                            kind: 'result',
                            protocolVersion: 1,
                            runId: 'api-capture-control',
                            agentId: 'agent-a',
                            commandId: decoded.envelope.commandId,
                            ok: result.ok,
                            result
                        }));
                        if (result.kind === 'recipe.run') {
                            assert(isJsonRecordValue(result.value));
                            assert(isJsonRecordValue(result.value.invocation));
                            expect(result.value.invocation.run).toEqual('off');
                            expect(result.value.invocation.recipe).toEqual('native');
                            completed.resolve();
                        }
                    }
                    catch (error) {
                        completed.reject(error);
                    }
                })();
            });
            const created = await fetch(`${server.baseUrl}/distributed-runs`, {
                method: 'POST',
                headers: adminHeaders(),
                body: JSON.stringify({ manifest })
            });
            const accepted: unknown = await created.json();
            expect(created.status).toEqual(201);
            assert(isJsonRecordValue(accepted));
            expect(accepted.manifest).toEqual(manifest);
            const started = await fetch(`${server.baseUrl}/distributed-runs/api-capture-run/start`, {
                method: 'POST',
                headers: adminHeaders()
            });
            expect(started.status).toEqual(202);
            await started.body?.cancel();
            const timeout = setTimeout(() => completed.reject(new Error('The actual capture invocation did not complete.')), 5_000);
            try {
                await completed.promise;
            }
            finally {
                clearTimeout(timeout);
            }
            await waitForPersistedSnapshot(storageDir, '"state":"passed"');
            const run = await getJson<unknown>(server.baseUrl, '/distributed-runs/api-capture-run');
            assert(isJsonRecordValue(run));
            expect(run.state).toEqual('passed');
            expect(run.manifest).toEqual(manifest);
            const artifact = await getJson<unknown>(server.baseUrl, '/distributed-runs/api-capture-run/artifacts');
            assert(isJsonRecordValue(artifact));
            assert(isJsonRecordValue(artifact.files));
            assert(typeof artifact.files['manifest.json'] === 'string');
            expect(JSON.parse(artifact.files['manifest.json'])).toEqual(manifest);
        }
        finally {
            try {
                socket?.close();
            }
            finally {
                await server.stop();
            }
        }
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('read-token mode protects run, fleet, and distributed GET routes', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-api-'));
    try {
        const server = await startControlServer({
            RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
            RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN: '1',
            RALLAR_BLACK_BOX_STORAGE_DIR: storageDir
        });
        try {
            const health = await getJson<unknown>(server.baseUrl, '/health');
            assert(isJsonRecordValue(health));
            expect(health.ok).toEqual(true);

            const openApi = await fetch(`${server.baseUrl}/api/openapi.json`);
            expect(openApi.status).toEqual(200);

            for (const path of ['/runs', '/distributed-runs', '/fleet/reports']) {
                const unauthorized = await fetch(`${server.baseUrl}${path}`);
                expect(unauthorized.status).toEqual(401);

                const authorized = await fetch(`${server.baseUrl}${path}`, {
                    headers: adminHeaders()
                });
                expect(authorized.status).toEqual(200);
            }
        }
        finally {
            await server.stop();
        }
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('read-token mode fails closed without an auth backend', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-api-'));
    try {
        const server = await startControlServer({
            RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN: '1',
            RALLAR_BLACK_BOX_STORAGE_DIR: storageDir
        });
        try {
            const health = await getJson<unknown>(server.baseUrl, '/health');
            assert(isJsonRecordValue(health));
            expect(health.ok).toEqual(true);

            for (const path of ['/runs', '/distributed-runs', '/fleet/reports']) {
                const unauthorized = await fetch(`${server.baseUrl}${path}`);
                expect(unauthorized.status).toEqual(401);
            }
        }
        finally {
            await server.stop();
        }
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});

test('distributed and fleet APIs validate auth, artifacts, filters, and persisted restore', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-control-api-'));
    try {
        const server = await startControlServer({
            RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
            RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: OPERATOR_TOKEN_SECRET,
            RALLAR_BLACK_BOX_STORAGE_DIR: storageDir
        });
        let agentSocket: WebSocket | undefined;
        try {
            agentSocket = await registerAgent(
                server.baseUrl,
                'api-control-run',
                'agent-a'
            );

            const unauthorizedCreate = await fetch(
                `${server.baseUrl}/distributed-runs`,
                {
                    method: 'POST',
                    body: JSON.stringify({ manifest: distributedManifest() })
                }
            );
            expect(unauthorizedCreate.status).toEqual(401);

            const signedOperatorToken = await operatorToken();
            const unversionedRecipeResponse = await fetch(`${server.baseUrl}/distributed-runs`, {
                method: 'POST',
                headers: bearerJsonHeaders(signedOperatorToken),
                body: JSON.stringify({
                    manifest: {
                        ...distributedManifest(),
                        recipes: [{
                            recipeId: 'api-health',
                            recipe: { recipeId: 'api-health', commands: [] },
                            variables: {}
                        }]
                    }
                })
            });
            expect(unversionedRecipeResponse.status).toEqual(400);
            expect(await unversionedRecipeResponse.json()).toEqual({
                error: '$.recipes[0].recipe: Missing required property schemaVersion.'
            });

            const previewResponse = await fetch(
                `${server.baseUrl}/distributed-runs/resolve-targets`,
                {
                    method: 'POST',
                    headers: bearerJsonHeaders(signedOperatorToken),
                    body: JSON.stringify({
                        manifest: {
                            ...distributedManifest(),
                            targetPolicy: {
                                mode: 'all-online-group-members',
                                expectedParticipantCount: 1
                            },
                            roleAssignmentPolicy: {
                                mode: 'ordered-targets',
                                pattern: 'one-sender-many-receivers',
                                orderBy: 'agent-id'
                            }
                        }
                    })
                }
            );
            expect(previewResponse.status).toEqual(200);
            const preview = assertRight(decodeTargetResolution(await previewResponse.json()));
            expect(preview.targetAgentIds).toEqual(['agent-a']);
            expect(preview.summary.selected).toEqual(1);
            expect(preview.summary.expectedParticipantCount).toEqual(1);
            expect(preview.summary.roleCounts).toEqual({ sender: 1 });

            const createdResponse = await fetch(`${server.baseUrl}/distributed-runs`, {
                method: 'POST',
                headers: bearerJsonHeaders(signedOperatorToken),
                body: JSON.stringify({ manifest: distributedManifest() })
            });
            expect(createdResponse.status).toEqual(201);
            const created = assertRight(decodeControlDistributedRunSnapshot(await createdResponse.json()));
            expect(created.distributedRunId).toEqual('api-dist-1');
            expect(created.targetAgentIds).toEqual(['agent-a']);

            const stagedResponse = await fetch(
                `${server.baseUrl}/distributed-runs/api-dist-1/stage`,
                {
                    method: 'POST',
                    headers: bearerJsonHeaders(signedOperatorToken)
                }
            );
            expect(stagedResponse.status).toEqual(202);
            const staged = assertRight(decodeControlDistributedRunSnapshot(await stagedResponse.json()));
            expect(staged.state).toEqual('waiting-for-ack');
            expect(staged.commandLinks.length).toEqual(1);
            expect(staged.commandLinks[0].phase).toEqual('stage');
            expect(staged.commandLinks[0].agentId).toEqual('agent-a');
            expect(staged.commandLinks[0].recipeId).toEqual('api-health');

            const startedResponse = await fetch(
                `${server.baseUrl}/distributed-runs/api-dist-1/start`,
                {
                    method: 'POST',
                    headers: bearerJsonHeaders(signedOperatorToken)
                }
            );
            expect(startedResponse.status).toEqual(202);
            const started = assertRight(decodeControlDistributedRunSnapshot(await startedResponse.json()));
            expect(started.state).toEqual('waiting-for-ack');

            const distributed = assertRight(decodeControlDistributedRunSnapshot(
                await getJson<unknown>(server.baseUrl, '/distributed-runs/api-dist-1')
            ));
            expect(distributed.manifest.distributedRunId).toEqual('api-dist-1');

            const distributedArtifact = await getJson<unknown>(server.baseUrl, '/distributed-runs/api-dist-1/artifacts');
            assert(isJsonRecordValue(distributedArtifact));
            assert(isJsonRecordValue(distributedArtifact.files));
            assert(typeof distributedArtifact.files['manifest.json'] === 'string');
            expect(distributedArtifact.artifactSchemaVersion).toEqual(2);
            assert(distributedArtifact.files['manifest.json'].includes('api-dist-1'));
            assert('metadata.json' in distributedArtifact.files);

            const fleet = await getJson<unknown>(server.baseUrl, '/fleet/reports?region=eu-north');
            assert(isJsonRecordValue(fleet));
            assert(Array.isArray(fleet.reports));
            assert(isJsonRecordValue(fleet.aggregate));
            expect(fleet.reports.length).toEqual(0);
            expect(fleet.aggregate.runCount).toEqual(0);

            const unauthorizedRebuild = await fetch(
                `${server.baseUrl}/fleet/reports/rebuild`,
                {
                    method: 'POST'
                }
            );
            expect(unauthorizedRebuild.status).toEqual(401);
            const rebuildResponse = await fetch(
                `${server.baseUrl}/fleet/reports/rebuild`,
                {
                    method: 'POST',
                    headers: adminHeaders()
                }
            );
            expect(rebuildResponse.status).toEqual(200);

            await waitForPersistedSnapshot(storageDir, 'api-dist-1');
            agentSocket.close();
            agentSocket = undefined;
            await waitForPersistedSnapshot(storageDir, '"state":"failed"');
        }
        finally {
            try {
                agentSocket?.close();
            }
            finally {
                await server.stop();
            }
        }

        const restored = await startControlServer({
            RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
            RALLAR_BLACK_BOX_STORAGE_DIR: storageDir
        });
        try {
            const restoredRun = assertRight(decodeControlDistributedRunSnapshot(
                await getJson<unknown>(restored.baseUrl, '/distributed-runs/api-dist-1')
            ));
            expect(restoredRun.distributedRunId).toEqual('api-dist-1');
            expect(restoredRun.state).toEqual('failed');
        }
        finally {
            await restored.stop();
        }
    }
    finally {
        await rm(storageDir, { recursive: true, force: true });
    }
});
