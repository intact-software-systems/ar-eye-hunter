/// <reference lib="deno.ns" />

export type ApiV1BlackBoxBackend = 'postgres' | 'pglite-memory'

export type ApiV1BlackBoxOptions = Readonly<{
    backend: ApiV1BlackBoxBackend
    port: number
    profile: string
    artifactDir: string
    runId: string
    requireGates: boolean
    runMigrations: boolean
    recipesOnly: boolean
}>

const SCRIPT_DIR = new URL('.', import.meta.url)
const REPO_ROOT = new URL('../../../', SCRIPT_DIR)
const API_CONFIG_PATH = 'apps/api-v1/deno.json'
const API_ENTRYPOINT = 'apps/api-v1/src/main.ts'
const DEFAULT_DATABASE_URL = 'postgres://app:app@localhost:5432/appdb'

export function parseApiV1BlackBoxArgs(args: readonly string[]): ApiV1BlackBoxOptions {
    const values = new Map<string, string | boolean>()
    for (const arg of args) {
        const [name, value] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, true]
        values.set(name, value)
    }

    const backend = String(values.get('--backend') ?? 'postgres') as ApiV1BlackBoxBackend
    if (backend !== 'postgres' && backend !== 'pglite-memory') {
        throw new Error('--backend must be postgres or pglite-memory.')
    }

    const port = Number(values.get('--port') ?? '18080')
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('--port must be an integer from 1 to 65535.')
    }

    const runId = String(values.get('--run-id') ?? defaultRunId())
    const artifactDir = String(
        values.get('--artifact-dir') ?? `.artifacts/api-v1-black-box/${backend}`,
    )
    const recipesOnly = values.get('--recipes-only') === true

    return {
        backend,
        port,
        profile: String(values.get('--profile') ?? 'api-v1-black-box'),
        artifactDir,
        runId,
        requireGates: values.get('--no-require-gates') !== true,
        runMigrations: backend === 'postgres' && !recipesOnly && values.get('--no-migrate') !== true,
        recipesOnly,
    }
}

function defaultRunId(): string {
    return `local-${Date.now()}`
}

export function toApiV1BlackBoxEnvironment(
    options: ApiV1BlackBoxOptions,
    baseEnv: Record<string, string | undefined>,
): Record<string, string> {
    const env: Record<string, string> = Object.fromEntries(
        Object.entries(baseEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
    env.PORT = String(options.port)
    const defaultApiBaseUrl = `http://127.0.0.1:${options.port}`
    const defaultWsBaseUrl = `ws://127.0.0.1:${options.port}`
    env.RALLAR_API_BASE_URL = options.recipesOnly
        ? env.RALLAR_API_BASE_URL ?? defaultApiBaseUrl
        : defaultApiBaseUrl
    env.RALLAR_WS_BASE_URL = options.recipesOnly
        ? env.RALLAR_WS_BASE_URL ?? defaultWsBaseUrl
        : defaultWsBaseUrl
    env.RALLAR_BB_RUN_ID = options.runId
    env.RALLAR_ICE_MODE = env.RALLAR_ICE_MODE ?? 'local'
    env.RALLAR_LOGIN_USER_RATE_LIMIT = env.RALLAR_LOGIN_USER_RATE_LIMIT ?? '100'
    env.RALLAR_STATE_STRICT_READ_AUTH = env.RALLAR_STATE_STRICT_READ_AUTH ?? '1'
    env.AUTH_STATIC_CLIENTS_MODE = env.AUTH_STATIC_CLIENTS_MODE ?? 'demo'
    env.AUTH_REGISTRATION_MODE = env.AUTH_REGISTRATION_MODE ?? 'public'

    if (options.backend === 'postgres') {
        env.RALLAR_SQL_BACKEND = 'postgres'
        env.DATABASE_URL = env.DATABASE_URL ?? DEFAULT_DATABASE_URL
    } else {
        env.RALLAR_SQL_BACKEND = 'pglite-memory'
        env.RALLAR_PGLITE_DATA_DIR = 'memory://'
        env.RALLAR_PGLITE_SCHEMA_INIT = 'auto'
        env.RALLAR_DB_PUBSUB = 'local'
        delete env.DATABASE_URL
    }

    return env
}

export function toApiV1ServerCommand(_options: ApiV1BlackBoxOptions): readonly string[] {
    return [
        'deno',
        'run',
        '--config',
        API_CONFIG_PATH,
        '--allow-net',
        '--allow-env',
        '--allow-read',
        API_ENTRYPOINT,
    ]
}

function toRecipeMatrixCommand(options: ApiV1BlackBoxOptions, artifactDir: string): readonly string[] {
    return [
        'deno',
        'run',
        '-A',
        'packages/shared-test/black-box-runner/recipe-matrix.mts',
        `--profile=${options.profile}`,
        ...(options.requireGates ? ['--require-gates'] : []),
        `--artifact-dir=${artifactDir}`,
    ]
}

function repoRootPath(): string {
    return decodeURIComponent(REPO_ROOT.pathname)
}

function resolveArtifactDir(path: string): string {
    if (path.startsWith('/')) {
        return path
    }

    return new URL(path.replaceAll('\\', '/') + '/', `file://${Deno.cwd().replace(/\/$/, '')}/`).pathname
}

async function runCommand(command: readonly string[], env: Record<string, string>): Promise<void> {
    const output = await new Deno.Command(command[0], {
        args: command.slice(1),
        cwd: repoRootPath(),
        env,
        stdout: 'piped',
        stderr: 'piped',
    }).output()

    const stdout = new TextDecoder().decode(output.stdout)
    const stderr = new TextDecoder().decode(output.stderr)
    if (stdout.trim()) {
        console.log(stdout)
    }
    if (stderr.trim()) {
        console.error(stderr)
    }

    if (!output.success) {
        throw new Error(`${command.join(' ')} failed with exit code ${output.code}`)
    }
}

function startServer(
    options: ApiV1BlackBoxOptions,
    env: Record<string, string>,
    logPath: string,
): Deno.ChildProcess {
    const [command, ...args] = toApiV1ServerCommand(options)
    const child = new Deno.Command(command, {
        args,
        cwd: repoRootPath(),
        env,
        stdout: 'piped',
        stderr: 'piped',
    }).spawn()

    if (child.stdout) {
        void appendStreamToFile(child.stdout, logPath)
    }
    if (child.stderr) {
        void appendStreamToFile(child.stderr, logPath)
    }

    return child
}

async function appendStreamToFile(stream: ReadableStream<Uint8Array>, path: string): Promise<void> {
    const reader = stream.getReader()
    const file = await Deno.open(path, {
        append: true,
        create: true,
        write: true,
    })
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) {
                return
            }
            if (value) {
                await file.write(value)
            }
        }
    } finally {
        file.close()
        reader.releaseLock()
    }
}

async function waitForApiConfig(baseUrl: string, timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    const url = baseUrl.replace(/\/+$/, '') + '/api/config'
    let lastError: unknown

    while (Date.now() < deadline) {
        try {
            const response = await fetch(url)
            if (response.ok) {
                return
            }
            lastError = new Error(`${url} returned ${response.status}`)
        } catch (error) {
            lastError = error
        }
        await sleep(250)
    }

    throw new Error(
        `Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function runRecipeMatrix(
    options: ApiV1BlackBoxOptions,
    env: Record<string, string>,
    artifactDir: string,
): Promise<void> {
    await runCommand(toRecipeMatrixCommand(options, artifactDir), env)
}

async function stopServer(child: Deno.ChildProcess | undefined): Promise<void> {
    if (!child) {
        return
    }

    try {
        child.kill('SIGTERM')
    } catch (_error) {
        return
    }

    const stopped = await Promise.race([
        child.status.then(() => true),
        sleep(5000).then(() => false),
    ])
    if (!stopped) {
        try {
            child.kill('SIGKILL')
        } catch (_error) {
            // Process already exited.
        }
        await child.status.catch(() => undefined)
    }
}

async function main(): Promise<void> {
    const options = parseApiV1BlackBoxArgs(Deno.args)
    const env = toApiV1BlackBoxEnvironment(options, Deno.env.toObject())
    const artifactDir = resolveArtifactDir(options.artifactDir)
    const logPath = artifactDir.replace(/\/+$/, '') + '/api-v1-server.log'
    let server: Deno.ChildProcess | undefined

    await Deno.mkdir(artifactDir, { recursive: true })
    if (options.runMigrations) {
        await runCommand(['npm', 'run', 'db:migrate'], env)
    }

    try {
        if (!options.recipesOnly) {
            await Deno.writeTextFile(logPath, '')
            server = startServer(options, env, logPath)
            await waitForApiConfig(env.RALLAR_API_BASE_URL)
        }

        await runRecipeMatrix(options, env, artifactDir)
    } finally {
        await stopServer(server)
    }
}

const importMeta = import.meta as ImportMeta & { main?: boolean }

if (importMeta.main) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : String(error))
        Deno.exit(1)
    })
}
