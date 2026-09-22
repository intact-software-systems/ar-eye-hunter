import { assertBlackBoxControlProductionEnv } from '@shared-server/http/black-box-control-production-env.ts';

import { ControlAgentSockets } from './control-agent-sockets.ts';
import { ControlArtifactRecorder } from './control-artifact-recorder.ts';
import { readBlackBoxControlServerConfiguration } from './control-server-configuration.ts';
import { createRallarBlackBoxControlService } from './control-service.ts';
import { createControlSnapshotPersistence } from './control-snapshot-persistence.ts';
import { applyControlCorsHeaders, corsOriginsFromAllowedOrigins } from './cors.ts';
import { createControlHttpResponses } from './http/control-http-responses.ts';
import { ControlHttpSecurity } from './http/control-http-security.ts';
import { createControlRequestBodyReader } from './http/control-request-body.ts';
import { createRetentionPlanTokenAdapter } from './retention-plan-token.ts';
import { routeControlHttpRequest } from './routes/control-http-router.ts';

const DEFAULT_PORT = 5180;

assertBlackBoxControlProductionEnv(Deno.env);

const security = readBlackBoxControlServerConfiguration(Deno.env);
const port = Number(Deno.env.get('PORT') ?? DEFAULT_PORT);
const corsOrigins = corsOriginsFromAllowedOrigins(security.allowedOrigins);

const controlService = createRallarBlackBoxControlService({
    dependencies: {
        now: () => Date.now(),
        createCommandId: () => crypto.randomUUID(),
        createRunToken: () => crypto.randomUUID()
    },
    config: {
        redaction: undefined,
        allowedCommandKinds: security.allowedCommandKinds,
        commandRateLimitMax: security.commandRateLimitMax,
        commandRateLimitWindowMs: security.commandRateLimitWindowMs,
        runtimeRetentionBounds: security.runtimeRetentionBounds
    }
});
const artifactRecorder = new ControlArtifactRecorder({
    storageDir: security.storageDir,
    commandSnapshots: controlService
});
const agentSockets = new ControlAgentSockets(controlService);
const snapshotPersistence = createControlSnapshotPersistence({
    storageDir: security.storageDir,
    retentionMaxRuns: security.retentionMaxRuns,
    snapshotBounds: security.snapshotPersistenceBounds,
    controlService,
    deleteRuns: (runIds) => {
        for (const runId of runIds) {
            agentSockets.closeRun(runId);
            artifactRecorder.deleteRun(runId);
        }
    }
});
const routeDependencies = {
    controlService,
    security: new ControlHttpSecurity({ configuration: security, controlService }),
    requestBody: createControlRequestBodyReader(security.maxRequestBytes),
    responses: createControlHttpResponses(corsOrigins),
    agentSockets,
    artifactRecorder,
    persistence: snapshotPersistence,
    retentionPlanTokens: createRetentionPlanTokenAdapter({ key: crypto.getRandomValues(new Uint8Array(32)) }),
    commandDestinations: security,
    retentionMaxRuns: security.retentionMaxRuns,
    runTokenTtlMs: security.runTokenTtlMs,
    now: () => Date.now()
};

await snapshotPersistence.restore();

Deno.serve({ port }, async (request) => {
    return applyControlCorsHeaders(request, await routeControlHttpRequest(request, routeDependencies), corsOrigins);
});

console.log(`Rallar black-box control server listening on http://localhost:${port}`);
console.log(`Agent WebSocket endpoint: ws://localhost:${port}/control`);
