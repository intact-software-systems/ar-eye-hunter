import { Hono } from 'hono';

import { createHttpTimingMiddleware } from '../../src/services/http-timing-middleware.ts';

/** Production installs the timing middleware outermost on `/api/*`, and every mutation route reads its trace. */
export function createTracedApiTestApp(): Hono {
    const app = new Hono();
    app.use('/api/*', createHttpTimingMiddleware({ timing: () => undefined }));
    return app;
}
