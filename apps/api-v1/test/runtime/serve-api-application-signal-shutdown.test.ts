import { expect, test } from 'bun:test';

const API_ROOT = new URL('../..', import.meta.url).pathname;
const STARTUP_TIMEOUT_MS = 60_000;
const EXIT_BOUND_MS = 10_000;
const PORT_RANGE_START = 20_000;
const PORT_RANGE_END = 32_768;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`the in-memory API exits 0 on ${signal} and releases its port`, async () => {
        const port = PORT_RANGE_START + Math.floor(Math.random() * (PORT_RANGE_END - PORT_RANGE_START));
        const child = Bun.spawn({
            cmd: [process.execPath, '--no-env-file', 'run', 'src/main.ts'],
            cwd: API_ROOT,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'inherit',
            env: {
                PATH: process.env['PATH'] ?? '',
                PORT: String(port),
                RALLAR_API_CONFIGURATION_PROFILE: 'prod-in-memory',
                RALLAR_AUTH_CREDENTIAL_SECRET: 'local-signal-shutdown-auth-credential-secret-v1',
                RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: 'local-signal-shutdown-operator-secret-v1'
            }
        });
        try {
            await readUntil(child.stdout, `Server started on port ${port}.`);
            child.kill(signal);
            const exit = await Promise.race([
                child.exited.then((code) => ({ code })),
                Bun.sleep(EXIT_BOUND_MS).then(() => ({ code: 'still-running' as const }))
            ]);

            expect(exit).toEqual({ code: 0 });
            Bun.listen({ hostname: '0.0.0.0', port, socket: { data: () => undefined } }).stop(true);
        }
        finally {
            child.kill('SIGKILL');
        }
    }, STARTUP_TIMEOUT_MS + EXIT_BOUND_MS);
}

/** Keeps draining after the marker so the child never writes into a closed pipe while it shuts down. */
function readUntil(stream: ReadableStream<Uint8Array>, marker: string): Promise<void> {
    const decoder = new TextDecoder();
    let text = '';
    return new Promise((resolve, reject) => {
        void (async () => {
            for await (const chunk of stream) {
                text += decoder.decode(chunk, { stream: true });
                if (text.includes(marker)) {
                    resolve();
                }
            }
            reject(new Error(`The API exited before printing "${marker}":\n${text}`));
        })();
    });
}
