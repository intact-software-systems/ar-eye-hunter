const API_ROOT = new URL('../..', import.meta.url).pathname;
const PORT_RANGE_START = 20_000;
const PORT_RANGE_END = 32_768;

export const IN_MEMORY_API_STARTUP_TIMEOUT_MS = 60_000;

export interface InMemoryApiProcess {
    readonly port: number;
    readonly baseUrl: string;
    readonly child: Bun.Subprocess<'ignore', 'pipe', 'inherit'>;
}

/** The real `src/main.ts` entry on the in-memory profile, reading no env files, once it reports that it listens. */
export async function startInMemoryApiProcess(): Promise<InMemoryApiProcess> {
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
            RALLAR_AUTH_CREDENTIAL_SECRET: 'local-in-memory-api-process-auth-credential-secret-v1',
            RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: 'local-in-memory-api-process-operator-secret-v1'
        }
    });
    await readUntil(child.stdout, `Server started on port ${port}.`);
    return { port, baseUrl: `http://127.0.0.1:${port}`, child };
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
