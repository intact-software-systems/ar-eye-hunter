const API_ROOT = new URL('../..', import.meta.url).pathname;
const PORT_RANGE_START = 20_000;
const PORT_RANGE_END = 32_768;

export const IN_MEMORY_API_STARTUP_TIMEOUT_MS = 60_000;

export interface InMemoryApiProcessOptions {
    /** An env file Bun reads instead of none; the injected environment must still win over it. */
    readonly envFile?: string;
}

export interface InMemoryApiProcess {
    readonly port: number;
    /** The port the server reported listening on. */
    readonly listenedPort: number;
    readonly baseUrl: string;
    readonly child: Bun.Subprocess<'ignore', 'pipe', 'inherit'>;
}

/** The real `src/main.ts` entry on the in-memory profile, reading no env files, once it reports that it listens. */
export async function startInMemoryApiProcess(options: InMemoryApiProcessOptions = {}): Promise<InMemoryApiProcess> {
    const port = PORT_RANGE_START + Math.floor(Math.random() * (PORT_RANGE_END - PORT_RANGE_START));
    const envFileFlag = options.envFile === undefined ? '--no-env-file' : `--env-file=${options.envFile}`;
    const child = Bun.spawn({
        cmd: [process.execPath, envFileFlag, 'run', 'src/main.ts'],
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
    const listenedPort = await readListenedPort(child.stdout);
    return { port, listenedPort, baseUrl: `http://127.0.0.1:${listenedPort}`, child };
}

/** Keeps draining after the marker so the child never writes into a closed pipe while it shuts down. */
function readListenedPort(stream: ReadableStream<Uint8Array>): Promise<number> {
    const decoder = new TextDecoder();
    let text = '';
    return new Promise((resolve, reject) => {
        void (async () => {
            for await (const chunk of stream) {
                text += decoder.decode(chunk, { stream: true });
                const started = /Server started on port (\d+)\./u.exec(text);
                if (started !== null) {
                    resolve(Number(started[1]));
                }
            }
            reject(new Error(`The API exited before reporting its port:\n${text}`));
        })();
    });
}
