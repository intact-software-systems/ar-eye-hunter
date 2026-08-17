import 'jsr:@std/dotenv@0.225.6/load';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import { cors } from 'jsr:@hono/hono@4.11.9/cors';

import { requireApiAuthSession, toAuthErrorResponse } from './services/request-auth-service.ts';
import { createDefaultRallarServer } from './composition/create-default-rallar-server.ts';
import { createStateApiResilienceMiddleware } from './services/state-api-resilience-middleware.ts';
import { createHttpTimingMiddleware } from './services/http-timing-middleware.ts';
import { logDatabaseBackendConfig, logPGliteSchemaInitConfig } from './db/database-config.ts';
import { logDatabasePubSubConfig } from './db/database-pubsub-config.ts';
import { assertApiV1ProductionEnv } from '@shared-server/http/production-env-hardening.ts';
import {
  STATE_SNAPSHOT_READ_EXPOSED_HEADERS,
} from './routes/state-snapshot-read-exposed-headers.ts';
import {
  stopApiOnRtcTopologyDeliveryHealthFailure,
} from './runtime/rtc-topology/rtc-topology-delivery-health-shutdown.ts';
import { startApiProcess } from './runtime/api-process-startup.ts';
import {
  logRtcTopologyReplayConfig,
  readApiRtcTopologyReplayConfig,
  shouldStartApiQueueWorkers,
} from './runtime/rtc-topology/rtc-topology-replay-config.ts';
import {
  logGroupFormationDampingConfig,
} from './runtime/group-formation/group-formation-damping-config.ts';
import {
  logGroupStateDisseminationConfig,
} from './runtime/group-formation/group-state-dissemination-config.ts';

const app: Hono = new Hono();
assertApiV1ProductionEnv(Deno.env);
const corsOrigins = readCorsOrigins();

logDatabaseBackendConfig();
logPGliteSchemaInitConfig();
logDatabasePubSubConfig();
const rtcTopologyReplayConfig = readApiRtcTopologyReplayConfig();
logRtcTopologyReplayConfig(console.log, rtcTopologyReplayConfig);
logGroupFormationDampingConfig(console.log);
logGroupStateDisseminationConfig(console.log);
const rallar = createDefaultRallarServer();
addEventListener('unload', () => {
  void rallar.runtime.backgroundTasks.stop().catch((error) => {
    console.error('Failed to stop middleware background tasks:', error);
  });
});

const apiCors = cors(
  {
    origin: (origin) => resolveCorsOrigin(origin, corsOrigins),
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-client-id'],
    exposeHeaders: [
      'Content-Length',
      'Server-Timing',
      'x-request-id',
      ...STATE_SNAPSHOT_READ_EXPOSED_HEADERS,
    ],
    maxAge: 600, // Cache the preflight for 10 minutes
    credentials: true,
  },
);

app.use('/api/*', async (c, next) => {
  if (isWebSocketUpgradeRequest(c.req.path, c.req.header('upgrade'))) {
    await next();
    return;
  }

  return await apiCors(c, next);
});

app.use('/api/*', createHttpTimingMiddleware());

app.use('/api/state/*', async (c, next) => {
  try {
    await requireApiAuthSession(c.req, rallar.runtime.authSessionRepository);
    await next();
  } catch (error) {
    return toAuthErrorResponse(c, error);
  }
});

app.use('/api/state/*', createStateApiResilienceMiddleware());

rallar.system
  .useDefaultMiddlewareTopics()
  .useWebSocketLifecycle();
rallar.ws.mount(app);
rallar.rest.mount(app);

const port = readServerPort();
const apiProcess = startApiProcess({
  runtimeReadiness: rallar.runtime.readiness,
  listen: () => Deno.serve({ port }, app.fetch),
  startQueueWorkers: () => {
    if (shouldStartApiQueueWorkers(rtcTopologyReplayConfig)) {
      rallar.start();
    }
  },
});
const httpServer = apiProcess.httpServer;
await apiProcess.readiness;
if (rallar.runtime.healthFailure) {
  void stopApiOnRtcTopologyDeliveryHealthFailure({
    healthFailure: rallar.runtime.healthFailure,
    onHealthFailure: (error) => {
      console.error('RTC topology delivery health failed; stopping API process:', error);
    },
    stopQueueWorkers: () => rallar.runtime.qboxEngine.stop(),
    closeWebSockets: () => {
      const socketServer = rallar.runtime.wsQBoxServerService.socket;
      for (const connectionId of socketServer.connections.keys()) {
        socketServer.closeConnection(
          connectionId,
          1012,
          'rtc-topology-delivery-lease-lost',
        );
      }
    },
    stopBackgroundTasks: () => rallar.runtime.backgroundTasks.stop(),
    shutdownHttp: async () => await httpServer.shutdown(),
    onShutdownStepFailure: (step, error) => {
      console.error(`RTC topology delivery shutdown step ${step} failed:`, error);
    },
  });
}
console.log(`Server started on port ${port}. http://localhost:${port}/api/docs`);

function readCorsOrigins(): readonly string[] {
  const raw = Deno.env.get('CORS_ORIGINS') ??
    'http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176';

  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function readServerPort(): number {
  const raw = Deno.env.get('PORT')?.trim();
  if (!raw) {
    return 8080;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer from 1 to 65535. Received: ${raw}`);
  }

  return port;
}

function resolveCorsOrigin(
  origin: string,
  allowedOrigins: readonly string[],
): string | undefined {
  if (allowedOrigins.includes('*')) {
    return origin || undefined;
  }

  return allowedOrigins.includes(origin) ? origin : undefined;
}

function isWebSocketUpgradeRequest(path: string, upgrade?: string): boolean {
  return path.startsWith('/api/ws/') && upgrade?.trim().toLowerCase() === 'websocket';
}
