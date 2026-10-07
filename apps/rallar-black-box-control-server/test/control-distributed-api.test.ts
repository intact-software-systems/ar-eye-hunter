import { assert, assertEquals } from '@std/assert';

import { parseControlServerMessage } from '@shared-test/rallar-bb-test/control-protocol.ts';
import {
    decodeControlDistributedRunSnapshot,
    decodeTargetResolution
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import { createRallarBlackBoxRtcSmokeRecipe } from '@shared-test/rallar-bb-test/fixtures/rtc-live-recipes.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
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

Deno.test('distributed HTTP stage and unstaged start visibly refuse unsupported required capture', async () => {
    assert(await canBindLoopback(), 'HTTP capture admission requires a local listener.');
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-capture-admission-' });
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
                assertEquals(created.status, 201);
                await created.body?.cancel();
                const refused = await fetch(`${server.baseUrl}/distributed-runs/${distributedRunId}/${phase}`, { method: 'POST', headers: adminHeaders() });
                const response: unknown = await refused.json();
                const snapshot = await getJson<unknown>(server.baseUrl, `/distributed-runs/${distributedRunId}`);
                assert(isJsonRecordValue(snapshot));
                assertEquals({
                    refused: refused.status >= 400 || snapshot.state === 'failed',
                    captureReason: JSON.stringify(response).toLowerCase().includes('capture'),
                    links: snapshot.commandLinks
                }, {
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
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('distributed HTTP admission retains explicit Off through actual results and serialized export', async () => {
    assert(await canBindLoopback(), 'This HTTP capture proof requires a local controller listener.');
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-control-capture-' });
    try {
        const server = await startControlServer({
            RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
            RALLAR_BLACK_BOX_STORAGE_DIR: storageDir
        });
        let socket: WebSocket | undefined;
        try {
            const manifest: unknown = JSON.parse(
                await Deno.readTextFile(
                    new URL(
                        '../../../packages/shared-test/black-box-runner/fixtures/distributed-run-capture.json',
                        import.meta.url
                    )
                )
            );
            assert(isJsonRecordValue(manifest));
            const agentSocket = await registerAgent(server.baseUrl, 'api-capture-control', 'agent-a');
            socket = agentSocket;
            const runtime = createRallarBlackBoxTestRuntime();
            const completed = Promise.withResolvers<void>();
            agentSocket.addEventListener('message', (event) => {
                void (async () => {
                    try {
                        const decoded = parseControlServerMessage(event.data, { runId: 'api-capture-control', agentId: 'agent-a' });
                        assert(decoded.ok);
                        const result = await runtime.execute({ ...decoded.envelope.command, commandId: decoded.envelope.commandId });
                        assertEquals(result.ok, true);
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
                            assertEquals(result.value.invocation.run, 'off');
                            assertEquals(result.value.invocation.recipe, 'native');
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
            assertEquals(created.status, 201, JSON.stringify(accepted));
            assert(isJsonRecordValue(accepted));
            assertEquals(accepted.manifest, manifest);
            const started = await fetch(`${server.baseUrl}/distributed-runs/api-capture-run/start`, {
                method: 'POST',
                headers: adminHeaders()
            });
            assertEquals(started.status, 202);
            await started.body?.cancel();
            const timeout = setTimeout(() => completed.reject(new Error('The actual capture invocation did not complete.')), 5_000);
            try {
                await completed.promise;
            }
            finally {
                clearTimeout(timeout);
            }
            await waitForPersistedSnapshot(storageDir, '"state": "passed"');
            const run = await getJson<unknown>(server.baseUrl, '/distributed-runs/api-capture-run');
            assert(isJsonRecordValue(run));
            assertEquals(run.state, 'passed');
            assertEquals(run.manifest, manifest);
            const artifact = await getJson<unknown>(server.baseUrl, '/distributed-runs/api-capture-run/artifacts');
            assert(isJsonRecordValue(artifact));
            assert(isJsonRecordValue(artifact.files));
            assert(typeof artifact.files['manifest.json'] === 'string');
            assertEquals(JSON.parse(artifact.files['manifest.json']), manifest);
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
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('read-token mode protects run, fleet, and distributed GET routes', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-control-api-' });
    try {
        const server = await startControlServer({
            RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
            RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN: '1',
            RALLAR_BLACK_BOX_STORAGE_DIR: storageDir
        });
        try {
            const health = await getJson<unknown>(server.baseUrl, '/health');
            assert(isJsonRecordValue(health));
            assertEquals(health.ok, true);

            const openApi = await fetch(`${server.baseUrl}/api/openapi.json`);
            assertEquals(openApi.status, 200);

            for (const path of ['/runs', '/distributed-runs', '/fleet/reports']) {
                const unauthorized = await fetch(`${server.baseUrl}${path}`);
                assertEquals(unauthorized.status, 401);

                const authorized = await fetch(`${server.baseUrl}${path}`, {
                    headers: adminHeaders()
                });
                assertEquals(authorized.status, 200);
            }
        }
        finally {
            await server.stop();
        }
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('read-token mode fails closed without an auth backend', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-control-api-' });
    try {
        const server = await startControlServer({
            RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN: '1',
            RALLAR_BLACK_BOX_STORAGE_DIR: storageDir
        });
        try {
            const health = await getJson<unknown>(server.baseUrl, '/health');
            assert(isJsonRecordValue(health));
            assertEquals(health.ok, true);

            for (const path of ['/runs', '/distributed-runs', '/fleet/reports']) {
                const unauthorized = await fetch(`${server.baseUrl}${path}`);
                assertEquals(unauthorized.status, 401);
            }
        }
        finally {
            await server.stop();
        }
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});

Deno.test('distributed and fleet APIs validate auth, artifacts, filters, and persisted restore', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-control-api-' });
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
            assertEquals(unauthorizedCreate.status, 401);

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
            assertEquals(unversionedRecipeResponse.status, 400);
            assertEquals(await unversionedRecipeResponse.json(), {
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
            assertEquals(previewResponse.status, 200);
            const preview = assertRight(decodeTargetResolution(await previewResponse.json()));
            assertEquals(preview.targetAgentIds, ['agent-a']);
            assertEquals(preview.summary.selected, 1);
            assertEquals(preview.summary.expectedParticipantCount, 1);
            assertEquals(preview.summary.roleCounts, { sender: 1 });

            const createdResponse = await fetch(`${server.baseUrl}/distributed-runs`, {
                method: 'POST',
                headers: bearerJsonHeaders(signedOperatorToken),
                body: JSON.stringify({ manifest: distributedManifest() })
            });
            assertEquals(createdResponse.status, 201);
            const created = assertRight(decodeControlDistributedRunSnapshot(await createdResponse.json()));
            assertEquals(created.distributedRunId, 'api-dist-1');
            assertEquals(created.targetAgentIds, ['agent-a']);

            const stagedResponse = await fetch(
                `${server.baseUrl}/distributed-runs/api-dist-1/stage`,
                {
                    method: 'POST',
                    headers: bearerJsonHeaders(signedOperatorToken)
                }
            );
            assertEquals(stagedResponse.status, 202);
            const staged = assertRight(decodeControlDistributedRunSnapshot(await stagedResponse.json()));
            assertEquals(staged.state, 'waiting-for-ack');
            assertEquals(staged.commandLinks.length, 1);
            assertEquals(staged.commandLinks[0].phase, 'stage');
            assertEquals(staged.commandLinks[0].agentId, 'agent-a');
            assertEquals(staged.commandLinks[0].recipeId, 'api-health');

            const startedResponse = await fetch(
                `${server.baseUrl}/distributed-runs/api-dist-1/start`,
                {
                    method: 'POST',
                    headers: bearerJsonHeaders(signedOperatorToken)
                }
            );
            assertEquals(startedResponse.status, 202);
            const started = assertRight(decodeControlDistributedRunSnapshot(await startedResponse.json()));
            assertEquals(started.state, 'waiting-for-ack');

            const distributed = assertRight(decodeControlDistributedRunSnapshot(
                await getJson<unknown>(server.baseUrl, '/distributed-runs/api-dist-1')
            ));
            assertEquals(distributed.manifest.distributedRunId, 'api-dist-1');

            const distributedArtifact = await getJson<unknown>(server.baseUrl, '/distributed-runs/api-dist-1/artifacts');
            assert(isJsonRecordValue(distributedArtifact));
            assert(isJsonRecordValue(distributedArtifact.files));
            assert(typeof distributedArtifact.files['manifest.json'] === 'string');
            assertEquals(distributedArtifact.artifactSchemaVersion, 2);
            assert(distributedArtifact.files['manifest.json'].includes('api-dist-1'));
            assert('metadata.json' in distributedArtifact.files);

            const fleet = await getJson<unknown>(server.baseUrl, '/fleet/reports?region=eu-north');
            assert(isJsonRecordValue(fleet));
            assert(Array.isArray(fleet.reports));
            assert(isJsonRecordValue(fleet.aggregate));
            assertEquals(fleet.reports.length, 0);
            assertEquals(fleet.aggregate.runCount, 0);

            const unauthorizedRebuild = await fetch(
                `${server.baseUrl}/fleet/reports/rebuild`,
                {
                    method: 'POST'
                }
            );
            assertEquals(unauthorizedRebuild.status, 401);
            const rebuildResponse = await fetch(
                `${server.baseUrl}/fleet/reports/rebuild`,
                {
                    method: 'POST',
                    headers: adminHeaders()
                }
            );
            assertEquals(rebuildResponse.status, 200);

            await waitForPersistedSnapshot(storageDir, 'api-dist-1');
            agentSocket.close();
            agentSocket = undefined;
            await waitForPersistedSnapshot(storageDir, '"state": "failed"');
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
            assertEquals(restoredRun.distributedRunId, 'api-dist-1');
            assertEquals(restoredRun.state, 'failed');
        }
        finally {
            await restored.stop();
        }
    }
    finally {
        await Deno.remove(storageDir, { recursive: true });
    }
});
