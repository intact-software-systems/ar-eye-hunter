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

export type WaitForManagedApiReadyInput = Readonly<{
    baseUrl: string
    logPath: string
    childStatus: PromiseLike<Readonly<{
        success: boolean
        code: number
        signal: string | null
    }>>
    startup: PromiseLike<void>
    streamsDrained: PromiseLike<void>
    timeoutMs?: number
    fetchImpl?: (
        url: string,
        init?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<Pick<Response, 'ok' | 'status' | 'body'>>
    diagnosticSecrets?: readonly string[]
    readLogTail?: (path: string) => Promise<string>
    readTextFile?: (path: string) => Promise<string>
    now?: () => number
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}>

export type BoundedLogTailFile = Readonly<{
    size: () => Promise<number>
    readAt: (offset: number, target: Uint8Array) => Promise<number | null>
    close: () => void
}>

export type ReadBoundedLogTailOptions = Readonly<{
    openFile?: (path: string) => Promise<BoundedLogTailFile>
}>

type ManagedApiServer = Readonly<{
    child: Deno.ChildProcess
    startup: Promise<void>
    streamsDrained: Promise<void>
}>

const SCRIPT_DIR = new URL('.', import.meta.url)
const REPO_ROOT = new URL('../../../', SCRIPT_DIR)
const API_CONFIG_PATH = 'apps/api-v1/deno.json'
const API_ENTRYPOINT = 'apps/api-v1/src/main.ts'
const DEFAULT_DATABASE_URL = 'postgres://app:app@localhost:5432/appdb'
const LOG_TAIL_MAX_BYTES = 4096
const MANAGED_SECRET_ENV_KEY = /(?:^|_)(?:PASSWORD|PASSWD|TOKEN|SECRET|DATABASE_URL|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)(?:_|$)/i
const URL_USERINFO_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi
const BEARER_CREDENTIAL = /(\bBearer\s+)[^\s,;]+/gi
const SENSITIVE_QUERY_VALUE = /([?&][^=\s&#]*(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|signature|credential)[^=\s&#]*=)([^&#\s]*)/gi
const SENSITIVE_ASSIGNMENT = /(\b[A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*)([^\s,;&]+)/gi

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
        profile: String(values.get('--profile') ?? (
            recipesOnly ? 'api-v1-black-box-recipes' : 'api-v1-black-box'
        )),
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
    env.RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET = env.RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET
        ?? 'local-api-v1-black-box-operator-secret'
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
): ManagedApiServer {
    const [command, ...args] = toApiV1ServerCommand(options)
    const child = new Deno.Command(command, {
        args,
        cwd: repoRootPath(),
        env,
        stdout: 'piped',
        stderr: 'piped',
    }).spawn()

    const expectedStartupMarker = `Server started on port ${options.port}.`
    const stdoutDecoder = new TextDecoder()
    let stdoutTail = ''
    let startupObserved = false
    let resolveStartup!: () => void
    const startup = new Promise<void>(resolve => {
        resolveStartup = resolve
    })
    const observeStdout = (chunk: Uint8Array): void => {
        const text = stdoutTail + stdoutDecoder.decode(chunk, { stream: true })
        if (!startupObserved && text.includes(expectedStartupMarker)) {
            startupObserved = true
            resolveStartup()
        }
        stdoutTail = text.slice(-(expectedStartupMarker.length - 1))
    }
    const streamPumps: Promise<void>[] = []

    if (child.stdout) {
        streamPumps.push(appendStreamToFile(child.stdout, logPath, observeStdout))
    }
    if (child.stderr) {
        streamPumps.push(appendStreamToFile(child.stderr, logPath))
    }

    return {
        child,
        startup,
        streamsDrained: Promise.allSettled(streamPumps).then(() => undefined),
    }
}

async function appendStreamToFile(
    stream: ReadableStream<Uint8Array>,
    path: string,
    observe?: (chunk: Uint8Array) => void,
): Promise<void> {
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
                observe?.(value)
            }
        }
    } finally {
        file.close()
        reader.releaseLock()
    }
}

export async function waitForManagedApiReady(input: WaitForManagedApiReadyInput): Promise<void> {
    const timeoutMs = input.timeoutMs ?? 30000
    const fetchImpl = input.fetchImpl ?? globalThis.fetch
    const readLogTail = resolveLogTailReader(input)
    const diagnosticSecrets = normalizeDiagnosticSecrets(input.diagnosticSecrets ?? [])
    const now = input.now ?? Date.now
    const sleepImpl = input.sleep ?? sleep
    const deadline = now() + timeoutMs
    const url = input.baseUrl.replace(/\/+$/, '') + '/api/config'
    const controller = new AbortController()
    let winner: 'ready' | 'child' | 'timeout' | 'error' | undefined
    let startupObserved = false
    let lastError: unknown
    let resolveCompletion!: () => void
    let rejectCompletion!: (error: unknown) => void
    const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve
        rejectCompletion = reject
    })

    const claim = (candidate: NonNullable<typeof winner>): boolean => {
        if (winner) {
            return false
        }
        winner = candidate
        return true
    }

    const abort = (reason: Error): void => {
        if (!controller.signal.aborted) {
            controller.abort(reason)
        }
    }

    const settleUnexpectedError = (error: unknown): void => {
        if (!claim('error')) {
            return
        }
        const reason = error instanceof Error ? error : new Error(String(error))
        abort(reason)
        rejectCompletion(reason)
    }

    const triggerTimeout = (): void => {
        if (!claim('timeout')) {
            return
        }
        abort(new Error(`Timed out waiting for ${url}`))
        void managedApiTimeoutError(
            url,
            startupObserved,
            lastError,
            input.logPath,
            readLogTail,
            diagnosticSecrets,
        ).then(rejectCompletion, rejectCompletion)
    }

    const checkDeadline = (): void => {
        if (!winner && now() >= deadline) {
            triggerTimeout()
        }
    }

    void Promise.resolve(input.childStatus).then(async status => {
        if (!claim('child')) {
            return
        }
        abort(new Error(`API-v1 child exited before readiness (code ${status.code})`))
        await Promise.resolve(input.streamsDrained).catch(() => undefined)
        rejectCompletion(await managedApiChildExitError(
            status,
            input.logPath,
            readLogTail,
            diagnosticSecrets,
        ))
    }, settleUnexpectedError)

    const timeout = setTimeout(triggerTimeout, Math.max(0, timeoutMs))

    const readinessLoop = (async () => {
        try {
            await raceWithAbort(input.startup, controller.signal)
            startupObserved = true
            checkDeadline()

            while (!winner) {
                let response: Pick<Response, 'ok' | 'status' | 'body'> | undefined
                try {
                    const responseWithDisposedBody = Promise.resolve(
                        fetchImpl(url, { signal: controller.signal }),
                    ).then(configResponse => {
                        cancelResponseBodyBestEffort(configResponse)
                        return configResponse
                    })
                    response = await raceWithAbort(
                        responseWithDisposedBody,
                        controller.signal,
                    )
                } catch (error) {
                    if (winner) {
                        return
                    }
                    lastError = error
                }

                checkDeadline()
                if (winner) {
                    return
                }
                if (response?.ok) {
                    if (claim('ready')) {
                        abort(new Error('API-v1 managed readiness completed'))
                        resolveCompletion()
                    }
                    return
                }
                if (response) {
                    lastError = new Error(`${url} returned ${response.status}`)
                }

                try {
                    await raceWithAbort(
                        sleepImpl(250, controller.signal),
                        controller.signal,
                    )
                } catch (error) {
                    if (winner) {
                        return
                    }
                    throw error
                }
                checkDeadline()
            }
        } catch (error) {
            if (!winner) {
                settleUnexpectedError(error)
            }
        }
    })()

    try {
        await completion
    } finally {
        clearTimeout(timeout)
        abort(new Error('API-v1 managed readiness stopped'))
        await readinessLoop
    }
}

async function managedApiTimeoutError(
    url: string,
    startupObserved: boolean,
    lastError: unknown,
    logPath: string,
    readLogTail: (path: string) => Promise<string>,
    diagnosticSecrets: readonly string[],
): Promise<Error> {
    const reason = startupObserved
        ? lastError instanceof Error ? lastError.message : String(lastError ?? 'no successful response')
        : 'API-v1 child startup marker was not observed'
    const logTail = await readLogTailSafely(logPath, readLogTail)
    return new Error(redactManagedApiDiagnostic(
        `Timed out waiting for ${url}: ${reason}\nLatest API-v1 log tail:\n${logTail}`,
        diagnosticSecrets,
    ))
}

async function managedApiChildExitError(
    status: Awaited<WaitForManagedApiReadyInput['childStatus']>,
    logPath: string,
    readLogTail: (path: string) => Promise<string>,
    diagnosticSecrets: readonly string[],
): Promise<Error> {
    const signal = status.signal ? `, signal ${status.signal}` : ''
    const logTail = await readLogTailSafely(logPath, readLogTail)
    return new Error(redactManagedApiDiagnostic(
        `API-v1 child exited before readiness (code ${status.code}${signal})`
        + `\nLatest API-v1 log tail:\n${logTail}`,
        diagnosticSecrets,
    ))
}

export async function readBoundedLogTail(
    logPath: string,
    options: ReadBoundedLogTailOptions = {},
): Promise<string> {
    let file: BoundedLogTailFile | undefined
    try {
        file = await (options.openFile ?? openDenoBoundedLogTailFile)(logPath)
        const size = Math.max(0, await file.size())
        const length = Math.min(size, LOG_TAIL_MAX_BYTES)
        if (length === 0) {
            return '(empty)'
        }

        const bytes = new Uint8Array(length)
        const start = size - length
        let bytesRead = 0
        while (bytesRead < length) {
            const count = await file.readAt(start + bytesRead, bytes.subarray(bytesRead))
            if (count === null || count <= 0) {
                break
            }
            bytesRead += Math.min(count, length - bytesRead)
        }
        return normalizeLogTail(new TextDecoder().decode(bytes.subarray(0, bytesRead)))
    } catch (error) {
        return `[unable to read ${logPath}: ${error instanceof Error ? error.message : String(error)}]`
    } finally {
        try {
            file?.close()
        } catch (_error) {
            // Diagnostic cleanup must not replace the readiness outcome.
        }
    }
}

async function openDenoBoundedLogTailFile(path: string): Promise<BoundedLogTailFile> {
    const file = await Deno.open(path, { read: true })
    return {
        size: async () => (await file.stat()).size,
        readAt: async (offset, target) => {
            await file.seek(offset, Deno.SeekMode.Start)
            return await file.read(target)
        },
        close: () => file.close(),
    }
}

function resolveLogTailReader(input: WaitForManagedApiReadyInput): (path: string) => Promise<string> {
    if (input.readLogTail) {
        return input.readLogTail
    }
    if (input.readTextFile) {
        const readTextFile = input.readTextFile
        return async path => normalizeLogTail((await readTextFile(path)).slice(-LOG_TAIL_MAX_BYTES))
    }
    return readBoundedLogTail
}

async function readLogTailSafely(
    path: string,
    readLogTail: (path: string) => Promise<string>,
): Promise<string> {
    try {
        return normalizeLogTail(await readLogTail(path))
    } catch (error) {
        return `[unable to read ${path}: ${error instanceof Error ? error.message : String(error)}]`
    }
}

function normalizeLogTail(contents: string): string {
    return contents.trimEnd() || '(empty)'
}

function cancelResponseBodyBestEffort(
    response: Pick<Response, 'body'>,
): void {
    if (!response.body) {
        return
    }
    try {
        void Promise.resolve(response.body.cancel()).catch(() => undefined)
    } catch (_error) {
        // Body disposal cannot mask readiness, child-exit, or timeout outcomes.
    }
}

export function managedApiDiagnosticSecrets(env: Record<string, string>): readonly string[] {
    return Object.entries(env)
        .filter(([key, value]) => MANAGED_SECRET_ENV_KEY.test(key) && value.length > 0)
        .map(([, value]) => value)
}

function normalizeDiagnosticSecrets(secrets: readonly string[]): readonly string[] {
    return [...new Set(secrets.filter(secret => secret.length > 0))]
        .sort((left, right) => right.length - left.length)
}

function redactManagedApiDiagnostic(value: string, diagnosticSecrets: readonly string[]): string {
    let redacted = value
        .replace(URL_USERINFO_PASSWORD, '$1<redacted>$3')
        .replace(BEARER_CREDENTIAL, '$1<redacted>')
        .replace(SENSITIVE_QUERY_VALUE, '$1<redacted>')
        .replace(SENSITIVE_ASSIGNMENT, '$1<redacted>')

    for (const secret of diagnosticSecrets) {
        redacted = redacted.replaceAll(secret, '<redacted>')
    }
    return redacted
}

function raceWithAbort<T>(value: PromiseLike<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        let settled = false
        const finish = (callback: () => void): void => {
            if (settled) {
                return
            }
            settled = true
            signal.removeEventListener('abort', onAbort)
            callback()
        }
        const onAbort = (): void => {
            finish(() => reject(abortReason(signal)))
        }

        if (signal.aborted) {
            onAbort()
            return
        }

        signal.addEventListener('abort', onAbort, { once: true })
        Promise.resolve(value).then(
            result => finish(() => resolve(result)),
            error => finish(() => reject(error)),
        )
    })
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new Error('Operation aborted')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | undefined
        const cleanup = (): void => {
            if (timeout !== undefined) {
                clearTimeout(timeout)
            }
            signal?.removeEventListener('abort', onAbort)
        }
        const onAbort = (): void => {
            cleanup()
            reject(signal ? abortReason(signal) : new Error('Operation aborted'))
        }

        if (signal?.aborted) {
            onAbort()
            return
        }

        signal?.addEventListener('abort', onAbort, { once: true })
        timeout = setTimeout(() => {
            cleanup()
            resolve()
        }, ms)
    })
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
    let server: ManagedApiServer | undefined

    await Deno.mkdir(artifactDir, { recursive: true })
    if (options.runMigrations) {
        await runCommand(['npm', 'run', 'db:migrate'], env)
    }

    try {
        if (!options.recipesOnly) {
            await Deno.writeTextFile(logPath, '')
            server = startServer(options, env, logPath)
            await waitForManagedApiReady({
                baseUrl: env.RALLAR_API_BASE_URL,
                logPath,
                childStatus: server.child.status,
                startup: server.startup,
                streamsDrained: server.streamsDrained,
                diagnosticSecrets: managedApiDiagnosticSecrets(env),
            })
        }

        await runRecipeMatrix(options, env, artifactDir)
    } finally {
        await stopServer(server?.child)
    }
}

const importMeta = import.meta as ImportMeta & { main?: boolean }

if (importMeta.main) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : String(error))
        Deno.exit(1)
    })
}
