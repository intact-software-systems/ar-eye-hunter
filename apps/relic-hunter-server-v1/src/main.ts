import { loadSync } from 'jsr:@std/dotenv';
import { Hono } from 'jsr:@hono/hono';
import { cors } from 'jsr:@hono/hono/cors';

import { createRallarServer } from '../../api-v1/src/create-rallar-server.ts';
import { requireApiAuthSession, toAuthErrorResponse, } from '../../api-v1/src/services/request-auth-service.ts';
import { installRelicHunterGame } from './relic-game-service.ts';
import {
    createRelicExpeditionInitialStateFactory,
    readRelicAiExpeditionEnv,
} from './relic-expedition-ai.ts';
import { initRelicSwaggerRoutes } from './relic-swagger-routes.ts';
import { isRelicCommand, type RelicCommand } from '@relic-hunters/mod.ts';
import { configuration } from './config-repo.ts';

loadEnvironment();

const app: Hono = new Hono();
const port = Number(Deno.env.get('PORT') ?? '8090');
const rallar = createRallarServer({
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

app.use(
    '/api/*',
    cors({
        origin: (origin) => resolveCorsOrigin(origin, corsOrigins),
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization', 'x-client-id'],
        exposeHeaders: ['Content-Length'],
        maxAge: 600,
        credentials: true,
    }),
);

app.get('/api/config', (c) =>
    c.json(configuration)
);

initRelicSwaggerRoutes(app);

app.use('/api/relic/*', async (c, next) => {
    try {
        await requireApiAuthSession(c.req);
        await next();
    } catch (error) {
        return toAuthErrorResponse(c, error);
    }
});

app.get('/api/relic/games/:gameId', async (c) => {
    const gameId = c.req.param('gameId');
    return c.json(await relicGame.ensureSnapshot(gameId));
});

app.post('/api/relic/games/:gameId/commands', async (c) => {
    const gameId = c.req.param('gameId');
    const session = await requireApiAuthSession(c.req);
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
});

app.post('/api/relic/games/:gameId/reset', async (c) => {
    const gameId = c.req.param('gameId');
    const snapshot = await relicGame.reset(gameId);
    return c.json(snapshot);
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
