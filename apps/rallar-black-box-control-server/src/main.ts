import { assertBlackBoxControlProductionEnv } from '@shared-server/http/black-box-control-production-env.ts';

import { ControlAgentSockets } from './control-agent-sockets.ts';
import { ControlArtifactRecorder, DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG } from './control-artifact-recorder.ts';
import { startControlDeadlineSweep } from './control-deadline-sweep.ts';
import {
    readBlackBoxControlServerConfiguration,
    validateBlackBoxControlServerConfiguration
} from './control-server-configuration.ts';
import { createRallarBlackBoxControlService } from './control-service.ts';
import { ControlSnapshotPersistence } from './control-snapshot-persistence.ts';
import { createDefaultControlTimers } from './control-timers.ts';
import { applyControlCorsHeaders, corsOriginsFromAllowedOrigins } from './cors.ts';
import { toDistributedRunRollup } from './distributed/distributed-run-evaluation.ts';
import { createControlHttpResponses } from './http/control-http-responses.ts';
import { ControlHttpSecurity } from './http/control-http-security.ts';
import { createControlRequestBodyReader } from './http/control-request-body.ts';
import { createRetentionPlanTokenAdapter } from './retention-plan-token.ts';
import { routeControlHttpRequest } from './routes/control-http-router.ts';

const DEFAULT_PORT = 5180;

assertBlackBoxControlProductionEnv(Deno.env);

const security = readBlackBoxControlServerConfiguration(Deno.env);
const configurationIssues = validateBlackBoxControlServerConfiguration(security);
if (configurationIssues.length > 0) {
    throw new Error(`Invalid black-box control server configuration: ${configurationIssues.join(' ')}`);
}
const port = Number(Deno.env.get('PORT') ?? DEFAULT_PORT);
const corsOrigins = corsOriginsFromAllowedOrigins(security.allowedOrigins);
const timers = createDefaultControlTimers();

const controlService = createRallarBlackBoxControlService({
    dependencies: {
        now: timers.nowEpochMs,
        createCommandId: () => crypto.randomUUID(),
        createRunToken: () => crypto.randomUUID(),
        toDistributedRunRollup
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
    commandSnapshots: controlService,
    timers,
    config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
});
const agentSockets = new ControlAgentSockets(controlService);
const snapshotPersistence = new ControlSnapshotPersistence({
    storageDir: security.storageDir,
    retentionMaxRuns: security.retentionMaxRuns,
    snapshotBounds: security.snapshotPersistenceBounds,
    flushIntervalMs: security.snapshotFlushIntervalMs,
    controlService,
    deleteRuns: (runIds) => {
        for (const runId of runIds) {
            agentSockets.closeRun(runId);
            artifactRecorder.deleteRun(runId);
        }
    },
    timers
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
    now: timers.nowEpochMs
};

await snapshotPersistence.restore();
const stopDeadlineSweep = startControlDeadlineSweep({
    agentSockets,
    persistence: snapshotPersistence,
    timers,
    intervalMs: security.deadlineSweepIntervalMs
});

if (security.storageDir) {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        Deno.addSignalListener(signal, () => void stopControlServer());
    }
}

Deno.serve({ port }, async (request) => {
    return applyControlCorsHeaders(request, await routeControlHttpRequest(request, routeDependencies), corsOrigins);
});

console.log(`Rallar black-box control server listening on http://localhost:${port}`);
console.log(`Agent WebSocket endpoint: ws://localhost:${port}/control`);

async function stopControlServer(): Promise<void> {
    stopDeadlineSweep();
    await Promise.all([snapshotPersistence.stop(), artifactRecorder.stop()]);
    Deno.exit(0);
}
