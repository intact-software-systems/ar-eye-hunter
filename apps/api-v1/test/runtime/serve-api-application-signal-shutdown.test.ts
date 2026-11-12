import { expect, test } from 'bun:test';

import { IN_MEMORY_API_STARTUP_TIMEOUT_MS, startInMemoryApiProcess } from './in-memory-api-process.ts';

const EXIT_BOUND_MS = 10_000;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`the in-memory API exits 0 on ${signal} and releases its port`, async () => {
        const api = await startInMemoryApiProcess();
        try {
            api.child.kill(signal);
            const exit = await Promise.race([
                api.child.exited.then((code) => ({ code })),
                Bun.sleep(EXIT_BOUND_MS).then(() => ({ code: 'still-running' as const }))
            ]);

            expect(exit).toEqual({ code: 0 });
            Bun.listen({ hostname: '0.0.0.0', port: api.port, socket: { data: () => undefined } }).stop(true);
        }
        finally {
            api.child.kill('SIGKILL');
        }
    }, IN_MEMORY_API_STARTUP_TIMEOUT_MS + EXIT_BOUND_MS);
}
