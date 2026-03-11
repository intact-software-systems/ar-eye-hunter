/// <reference lib="deno.unstable" />
import 'jsr:@std/dotenv/load';
import { Hono } from 'jsr:@hono/hono';
import { cors } from 'jsr:@hono/hono/cors';

import { initialiseMiddleware } from './middleware.ts';

import * as wsTopics from './services/ws-topics-service.ts';
import * as wsLifecycle from './services/ws-lifecycle-service.ts';

import * as configRoutes from './routes/config-route.ts';
import * as wsRoutes from './routes/ws-routes.ts';
import * as iceRoutes from './routes/ice-route.ts';
import * as clientStateRoutes from './routes/client-state-routes.ts';
import * as groupStateRoutes from './routes/group-state-routes.ts';
import * as graphRoutes from './routes/graph-routes.ts';
import * as swaggerRoutes from './routes/swagger-routes.ts';
import { requireApiAuthSession, toAuthErrorResponse } from './services/request-auth-service.ts';

const app: Hono = new Hono();
const corsOrigins = readCorsOrigins();

app.use(
    '/api/*',
    cors(
        {
            origin: (origin) => resolveCorsOrigin(origin, corsOrigins),
            allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowHeaders: ['Content-Type', 'Authorization', 'x-client-id'],
            exposeHeaders: ['Content-Length'],
            maxAge: 600, // Cache the preflight for 10 minutes
            credentials: true,
        },
    ),
);

app.use('/api/state/*', async (c, next) => {
    try {
        await requireApiAuthSession(c.req);
        await next();
    } catch (error) {
        return toAuthErrorResponse(c, error);
    }
});

const mw = initialiseMiddleware();

wsTopics.initWsTopics(mw.wsQBoxServerService);
wsLifecycle.initWsLifecycle(mw.wsQBoxServerService);

configRoutes.init(app);
wsRoutes.init(app);
iceRoutes.init(app);
clientStateRoutes.init(app);
groupStateRoutes.init(app);
graphRoutes.init(app);
swaggerRoutes.init(app);

mw.qboxEngine.start();

Deno.serve({ port: 8080 }, app.fetch);
console.log('Server started on port 8080. http://localhost:8080/api/docs');

function readCorsOrigins(): readonly string[] {
    const raw = Deno.env.get('CORS_ORIGINS') ??
        'http://localhost:5173,http://localhost:5174';

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
