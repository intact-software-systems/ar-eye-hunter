import { chmod, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ManagedApiServerPlan = Readonly<{
    port: number;
    logPath: string;
    env: Record<string, string>;
}>;

export type ManagedApiServer = Readonly<{
    child: ManagedApiChild;
    startup: Promise<void>;
    streamsDrained: Promise<void>;
}>;

type ManagedApiChild = Readonly<{
    stdout: ReadableStream<Uint8Array> | null;
    stderr: ReadableStream<Uint8Array> | null;
    status: Promise<Readonly<{ success: boolean; code: number; signal: NodeJS.Signals | null; }>>;
    kill(signo?: NodeJS.Signals): void;
}>;

type ManagedApiFile = Readonly<{
    write(value: Uint8Array): Promise<number>;
    close(): void;
}>;

type ManagedApiSpawnInput = Readonly<{
    cmd: readonly string[];
    cwd: string;
    env: Record<string, string>;
    stdout: 'pipe';
    stderr: 'pipe';
}>;

type ManagedNodeRuntime = Readonly<{
    makeTempDir(input: Readonly<{ prefix: string; }>): Promise<string>;
    chmod(path: string, mode: number): Promise<void>;
    mkdir(path: string, input: Readonly<{ mode: number; }>): Promise<void>;
    remove(path: string, input: Readonly<{ recursive: boolean; }>): Promise<void>;
    open(path: string, input: Readonly<{ append: boolean; create: boolean; write: boolean; }>): Promise<ManagedApiFile>;
    spawn(input: ManagedApiSpawnInput): ManagedApiChild;
}>;

const defaultRuntime: ManagedNodeRuntime = {
    makeTempDir: ({ prefix }) => mkdtemp(join(tmpdir(), prefix)),
    chmod: (path, mode) => chmod(path, mode),
    mkdir: (path, { mode }) => mkdir(path, { mode }),
    remove: (path, { recursive }) => rm(path, { recursive }),
    open: async (path) => {
        const handle = await open(path, 'a');
        return {
            write: async (value) => {
                const { bytesWritten } = await handle.write(value);
                return bytesWritten;
            },
            close: () => {
                void handle.close();
            }
        };
    },
    spawn: (input) => {
        const child = Bun.spawn({
            cmd: [...input.cmd],
            cwd: input.cwd,
            env: input.env,
            stdout: 'pipe',
            stderr: 'pipe'
        });
        return {
            stdout: child.stdout,
            stderr: child.stderr,
            status: child.exited.then((code) => ({ success: code === 0, code, signal: null })),
            kill: (signo) => child.kill(signo)
        };
    }
};

export type ManagedPGliteRunStorage = Readonly<{
    dataDir: string;
    snapshotDir: string;
    cleanup(): Promise<void>;
}>;

type ManagedPGliteStorageOperations = Pick<ManagedNodeRuntime, 'chmod' | 'makeTempDir' | 'mkdir' | 'remove'>;

export async function createManagedPGliteRunStorage(
    operations: ManagedPGliteStorageOperations = defaultRuntime
): Promise<ManagedPGliteRunStorage> {
    const root = await operations.makeTempDir({ prefix: 'rallar-api-v1-pglite-' });
    const dataDir = `${root}/data`;
    const snapshotDir = `${root}/snapshot-control`;
    try {
        await operations.chmod(root, 0o700);
        await Promise.all([
            operations.mkdir(dataDir, { mode: 0o700 }),
            operations.mkdir(snapshotDir, { mode: 0o700 })
        ]);
    }
    catch (error) {
        await operations.remove(root, { recursive: true }).catch(() => undefined);
        throw error;
    }
    return {
        dataDir,
        snapshotDir,
        cleanup: async () => await operations.remove(root, { recursive: true })
    };
}

export async function withManagedPGliteRunStorage<T>(
    run: (storage: ManagedPGliteRunStorage) => Promise<T>
): Promise<T> {
    const storage = await createManagedPGliteRunStorage();
    try {
        return await run(storage);
    }
    finally {
        await storage.cleanup();
    }
}

export function startManagedApiServer(
    command: readonly string[],
    plan: ManagedApiServerPlan,
    cwd: string
): ManagedApiServer {
    const [program, ...args] = command;
    const child = defaultRuntime.spawn({
        cmd: [program, ...args],
        cwd,
        env: plan.env,
        stdout: 'pipe',
        stderr: 'pipe'
    });

    const expectedStartupMarker = `Server started on port ${plan.port}.`;
    const stdoutDecoder = new TextDecoder();
    let stdoutTail = '';
    let startupObserved = false;
    let resolveStartup!: () => void;
    const startup = new Promise<void>((resolve) => {
        resolveStartup = resolve;
    });
    const observeStdout = (chunk: Uint8Array): void => {
        const text = stdoutTail + stdoutDecoder.decode(chunk, { stream: true });
        if (!startupObserved && text.includes(expectedStartupMarker)) {
            startupObserved = true;
            resolveStartup();
        }
        stdoutTail = text.slice(-(expectedStartupMarker.length - 1));
    };
    const streamPumps: Promise<void>[] = [];
    if (child.stdout) {
        streamPumps.push(appendStreamToFile(child.stdout, plan.logPath, observeStdout));
    }
    if (child.stderr) {
        streamPumps.push(appendStreamToFile(child.stderr, plan.logPath));
    }
    return {
        child,
        startup,
        streamsDrained: Promise.allSettled(streamPumps).then(() => undefined)
    };
}

const GRACEFUL_STOP_BOUND_MS = 5000;

/** The API exits on SIGTERM after its graceful stop; needing SIGKILL is a shutdown defect, so it fails the stop. */
export async function stopManagedApiServer(child: ManagedApiChild | undefined): Promise<void> {
    if (!child) {
        return;
    }
    try {
        child.kill('SIGTERM');
    }
    catch (_error) {
        return;
    }
    const stopped = await Promise.race([
        child.status.then(() => true),
        sleep(GRACEFUL_STOP_BOUND_MS).then(() => false)
    ]);
    if (stopped) {
        return;
    }
    try {
        child.kill('SIGKILL');
    }
    catch (_error) {
        // Process already exited.
    }
    await child.status.catch(() => undefined);
    const message = `Managed API-v1 did not exit within ${GRACEFUL_STOP_BOUND_MS} ms of SIGTERM and was killed.`;
    console.error(message);
    throw new Error(message);
}

async function appendStreamToFile(
    stream: ReadableStream<Uint8Array>,
    path: string,
    observe?: (chunk: Uint8Array) => void
): Promise<void> {
    const reader = stream.getReader();
    const file = await defaultRuntime.open(path, {
        append: true,
        create: true,
        write: true
    });
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                return;
            }
            if (value) {
                await file.write(value);
                observe?.(value);
            }
        }
    }
    finally {
        file.close();
        reader.releaseLock();
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
