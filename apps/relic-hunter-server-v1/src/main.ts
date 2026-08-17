import { loadSync } from '@std/dotenv';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';

import { createDefaultRallarServer } from '@api-v1/src/composition/create-default-rallar-server.ts';
import {
  requireApiAuthSession,
  toAuthErrorResponse,
} from '@api-v1/src/services/request-auth-service.ts';
import { installRelicHunterGame } from './relic-game-service.ts';
import {
  createRelicExpeditionInitialStateFactory,
  readRelicAiExpeditionEnv,
} from './relic-expedition-ai.ts';
import { initRelicSwaggerRoutes } from './relic-swagger-routes.ts';
import { isRelicCommand, type RelicCommand } from '@relic-hunters/mod.ts';
import { configuration } from './config-repo.ts';
import { assertRelicProductionEnv } from '@shared-server/http/production-env-hardening.ts';
import {
  authorizeRelicCommand,
  authorizeRelicReset,
  authorizeRelicSnapshotRead,
  readRelicRestAuthMode,
  RelicRestGroupNotFoundError,
} from './relic-rest-auth.ts';
import {
  DEFAULT_STATE_APPLICATION_ID,
  DEFAULT_STATE_WORKSPACE_ID,
} from '@shared/api/state-types.ts';
import { isGroupPolicyDeniedError } from '@shared-server/rallar-system/group-policy.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

loadEnvironment();
assertRelicProductionEnv(Deno.env);

const app: Hono = new Hono();
const port = Number(Deno.env.get('PORT') ?? '8090');
const relicRestAuthMode = readRelicRestAuthMode(Deno.env);
const rallar = createDefaultRallarServer({
  ws: {
    allowImplicitUserTopics: false,
    defaultFanout: 'live-only',
  },
});
const relicAiExpeditionEnv = readRelicAiExpeditionEnv(Deno.env);
const relicGame = await installRelicHunterGame(rallar, {
  createInitialState: createRelicExpeditionInitialStateFactory({
    rallar,
    mode: relicAiExpeditionEnv.mode,
    timeoutMs: relicAiExpeditionEnv.timeoutMs,
    ollamaBaseUrl: relicAiExpeditionEnv.ollamaBaseUrl,
    ollamaModel: relicAiExpeditionEnv.ollamaModel,
    onFallback: (event) => {
      console.warn(
        `[relic-ai] expedition generation fell back for ${event.gameId}: ${event.error}`,
      );
    },
  }),
});
const corsOrigins = readCorsOrigins();

const apiCors = cors({
  origin: (origin) => resolveCorsOrigin(origin, corsOrigins),
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-client-id'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: true,
});

app.use('/api/*', async (c, next) => {
  if (isWebSocketUpgradeRequest(c.req.path, c.req.header('upgrade'))) {
    await next();
    return;
  }

  return await apiCors(c, next);
});

app.get('/api/config', (c) => c.json(configuration));

initRelicSwaggerRoutes(app);

app.use('/api/relic/*', async (c, next) => {
  try {
    await requireApiAuthSession(c.req, rallar.runtime.authSessionRepository);
    await next();
  } catch (error) {
    return toAuthErrorResponse(c, error);
  }
});

app.get('/api/relic/games/:gameId', async (c) => {
  try {
    const gameId = c.req.param('gameId');
    const session = await requireApiAuthSession(c.req, rallar.runtime.authSessionRepository);
    authorizeRelicSnapshotRead({
      mode: relicRestAuthMode,
      gameId,
      session,
      snapshot: await readRelicGroupSnapshotForPolicy(gameId),
    });
    return c.json(await relicGame.ensureSnapshot(gameId));
  } catch (error) {
    return relicRestErrorResponse(c, error);
  }
});

app.post('/api/relic/games/:gameId/commands', async (c) => {
  try {
    const gameId = c.req.param('gameId');
    const session = await requireApiAuthSession(c.req, rallar.runtime.authSessionRepository);
    authorizeRelicCommand({
      mode: relicRestAuthMode,
      gameId,
      session,
      snapshot: await readRelicGroupSnapshotForPolicy(gameId),
    });
    const body = await c.req.json().catch(() => undefined);
    const command = {
      ...(typeof body === 'object' && body !== null ? body : {}),
      gameId,
      username: session.username,
    } as RelicCommand;

    if (!isRelicCommand(command)) {
      return c.json({ error: 'Invalid relic command' }, 400);
    }

    return c.json(await relicGame.applyCommand(command, session.sessionId));
  } catch (error) {
    return relicRestErrorResponse(c, error);
  }
});

app.post('/api/relic/games/:gameId/reset', async (c) => {
  try {
    const gameId = c.req.param('gameId');
    const session = await requireApiAuthSession(c.req, rallar.runtime.authSessionRepository);
    authorizeRelicReset({
      mode: relicRestAuthMode,
      gameId,
      session,
      snapshot: await readRelicGroupSnapshotForPolicy(gameId),
    });
    const snapshot = await relicGame.reset(gameId);
    return c.json(snapshot);
  } catch (error) {
    return relicRestErrorResponse(c, error);
  }
});

rallar.system
  .useDefaultMiddlewareTopics()
  .useWebSocketLifecycle();
rallar.ws.mount(app);
rallar.rest.mount(app);
rallar.start();

Deno.serve({ port }, app.fetch);
console.log(`Relic Hunter server started on http://localhost:${port}`);

function readCorsOrigins(): readonly string[] {
  const raw = Deno.env.get('CORS_ORIGINS') ??
    'http://localhost:5173,http://localhost:5174,http://localhost:5175';

  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
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

async function readRelicGroupSnapshotForPolicy(
  gameId: string,
): Promise<GroupSnapshot | undefined> {
  if (relicRestAuthMode === 'authenticated') {
    return undefined;
  }

  return await rallar.runtime.groupStateService.readSnapshot({
    applicationId: DEFAULT_STATE_APPLICATION_ID,
    workspaceId: DEFAULT_STATE_WORKSPACE_ID,
    groupId: gameId,
  });
}

function relicRestErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof RelicRestGroupNotFoundError) {
    return c.json({ error: error.message }, error.status);
  }

  if (isGroupPolicyDeniedError(error)) {
    return c.json({
      error: error.message,
      code: error.denial.code,
      details: error.denial.details,
    }, error.status);
  }

  return toAuthErrorResponse(c, error);
}

function loadEnvironment(): void {
  loadEnvFileIfPresent(new URL('../.env', import.meta.url));
  loadEnvFileIfPresent(new URL('../.env.local', import.meta.url));
  loadEnvFileIfPresent(new URL('../../api-v1/.env', import.meta.url));
  loadEnvFileIfPresent(new URL('../../api-v1/.env.local', import.meta.url));
}

function loadEnvFileIfPresent(envPath: URL): void {
  try {
    loadSync({
      envPath,
      export: true,
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return;
    }

    throw error;
  }
}
