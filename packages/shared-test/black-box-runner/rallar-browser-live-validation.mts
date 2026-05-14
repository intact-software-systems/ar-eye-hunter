/// <reference lib="deno.ns" />
// deno-lint-ignore-file no-explicit-any
type ValidationMode = 'dry-run' | 'live' | 'both'
type ValidationTransport = 'realtime' | 'messages.rtc' | 'both'

type CliOptions = {
    mode: ValidationMode
    transport: ValidationTransport
    recordDir?: string
    continueOnFailure: boolean
    verbose: boolean
    help: boolean
}

type ValidationRun = {
    mode: Exclude<ValidationMode, 'both'>
    transport: Exclude<ValidationTransport, 'both'>
    scenarioPath: string
    success: boolean
    code: number
    stdout: string
    stderr: string
    parsedReport?: any
}

const SCRIPT_DIR = new URL('.', import.meta.url)
const REPO_ROOT = new URL('../../../', SCRIPT_DIR)
const SCENARIO_CLI = new URL('./scenario-black-box.ts', SCRIPT_DIR)
const SCENARIOS: Record<Exclude<ValidationTransport, 'both'>, URL> = {
    realtime: new URL('./examples/rtc-rallar-browser-realtime.json', SCRIPT_DIR),
    'messages.rtc': new URL('./examples/rtc-rallar-browser-messages-rtc.json', SCRIPT_DIR),
}

const REQUIRED_LIVE_ENV = [
    'RALLAR_API_BASE_URL',
    'RALLAR_ROOM_ID',
    'RALLAR_ALICE_USERNAME',
    'RALLAR_ALICE_PASSWORD',
    'RALLAR_BOB_USERNAME',
    'RALLAR_BOB_PASSWORD',
]

const SECRET_ENV = [
    'RALLAR_ALICE_PASSWORD',
    'RALLAR_BOB_PASSWORD',
]

function usage(): string {
    return [
        'Usage:',
        '  deno run -A packages/shared-test/black-box-runner/rallar-browser-live-validation.mts [options]',
        '',
        'Options:',
        '  --mode=dry-run|live|both       Default: dry-run',
        '  --transport=realtime|messages.rtc|both',
        '                                 Default: both',
        '  --record-dir=<dir>             Write redacted run artifacts as JSON',
        '  --verbose                      Print full redacted reports to stdout',
        '  --fail-fast                    Stop after first failed run',
        '  --continue-on-failure          Run every selected scenario before exiting',
        '  --help                         Print this help',
        '',
        'Required for --mode=live or --mode=both:',
        ...REQUIRED_LIVE_ENV.map(name => '  ' + name),
        '',
        'Optional:',
        '  RALLAR_MESSAGE_TYPE_ID         Default: black-box.chat.message',
        '  RALLAR_TOPIC_ID                Default: black-box.chat',
    ].join('\n')
}

function parseArgs(args: string[]): CliOptions {
    const options: CliOptions = {
        mode: 'dry-run',
        transport: 'both',
        continueOnFailure: true,
        verbose: false,
        help: false,
    }

    for (const arg of args) {
        if (arg === '--help' || arg === '-h') {
            options.help = true
            continue
        }

        if (arg === '--live') {
            options.mode = 'live'
            continue
        }

        if (arg === '--dry-run') {
            options.mode = 'dry-run'
            continue
        }

        if (arg === '--fail-fast') {
            options.continueOnFailure = false
            continue
        }

        if (arg === '--continue-on-failure') {
            options.continueOnFailure = true
            continue
        }

        if (arg === '--verbose') {
            options.verbose = true
            continue
        }

        if (arg.startsWith('--mode=')) {
            const mode = arg.slice('--mode='.length)
            if (mode !== 'dry-run' && mode !== 'live' && mode !== 'both') {
                throw new Error('Unsupported --mode value: ' + mode)
            }
            options.mode = mode
            continue
        }

        if (arg.startsWith('--transport=')) {
            const transport = arg.slice('--transport='.length)
            if (
                transport !== 'realtime' &&
                transport !== 'messages.rtc' &&
                transport !== 'both'
            ) {
                throw new Error('Unsupported --transport value: ' + transport)
            }
            options.transport = transport
            continue
        }

        if (arg.startsWith('--record-dir=')) {
            options.recordDir = arg.slice('--record-dir='.length)
            continue
        }

        throw new Error('Unknown argument: ' + arg)
    }

    return options
}

function filePath(url: URL): string {
    return decodeURIComponent(url.pathname)
}

function repoRelativePath(url: URL): string {
    const root = filePath(REPO_ROOT).replace(/\/$/, '') + '/'
    const path = filePath(url)
    return path.startsWith(root) ? path.slice(root.length) : path
}

function selectedModes(mode: ValidationMode): Array<Exclude<ValidationMode, 'both'>> {
    return mode === 'both' ? ['dry-run', 'live'] : [mode]
}

function selectedTransports(
    transport: ValidationTransport,
): Array<Exclude<ValidationTransport, 'both'>> {
    return transport === 'both' ? ['realtime', 'messages.rtc'] : [transport]
}

function envOrDefault(name: string, fallback: string): string {
    const value = Deno.env.get(name)
    return value && value.length > 0 ? value : fallback
}

function toReplacementMap(): Record<string, string> {
    return {
        rallarApiBaseUrl: envOrDefault('RALLAR_API_BASE_URL', 'https://api.example.com'),
        roomId: envOrDefault('RALLAR_ROOM_ID', 'room-1'),
        aliceUsername: envOrDefault('RALLAR_ALICE_USERNAME', 'alice'),
        alicePassword: envOrDefault('RALLAR_ALICE_PASSWORD', 'secret'),
        bobUsername: envOrDefault('RALLAR_BOB_USERNAME', 'bob'),
        bobPassword: envOrDefault('RALLAR_BOB_PASSWORD', 'secret'),
        messageTypeId: envOrDefault('RALLAR_MESSAGE_TYPE_ID', 'black-box.chat.message'),
        topicId: envOrDefault('RALLAR_TOPIC_ID', 'black-box.chat'),
    }
}

function assertReplacementValuesAreCliSafe(replacements: Record<string, string>): void {
    const unsafeNames = Object.entries(replacements)
        .filter(([, value]) => value.includes(','))
        .map(([name]) => name)

    if (unsafeNames.length > 0) {
        throw new Error(
            'Replacement values cannot contain commas with the current scenario CLI. Unsafe keys: ' +
            unsafeNames.join(', '),
        )
    }
}

function toReplacementArg(replacements: Record<string, string>): string {
    assertReplacementValuesAreCliSafe(replacements)
    return Object.entries(replacements)
        .map(([key, value]) => `${key}:=${value}`)
        .join(',')
}

function missingLiveEnv(): string[] {
    return REQUIRED_LIVE_ENV.filter(name => {
        const value = Deno.env.get(name)
        return !value || value.length === 0
    })
}

function assertLiveEnvironmentIfNeeded(options: CliOptions): void {
    if (!selectedModes(options.mode).includes('live')) {
        return
    }

    const missing = missingLiveEnv()
    if (missing.length === 0) {
        return
    }

    throw new Error(
        'Live rallar-browser validation requires deployed-service environment variables:\n' +
        missing.map(name => '  - ' + name).join('\n'),
    )
}

function toSecretMap(): Record<string, string> {
    return Object.fromEntries(
        SECRET_ENV
            .map(name => [name, Deno.env.get(name) || ''] as const)
            .filter(([, value]) => value.length > 0),
    )
}

function maskString(value: string, secrets = toSecretMap()): string {
    return Object.entries(secrets).reduce((masked, [name, secret]) => {
        return masked.replaceAll(secret, `<redacted:${name}>`)
    }, value)
}

function maskValue(value: any, secrets = toSecretMap()): any {
    if (typeof value === 'string') {
        return maskString(value, secrets)
    }

    if (Array.isArray(value)) {
        return value.map(item => maskValue(item, secrets))
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
                key,
                key.toLowerCase().includes('password')
                    ? '<redacted>'
                    : maskValue(child, secrets),
            ]),
        )
    }

    return value
}

function tryParseJson(text: string): any | undefined {
    try {
        return JSON.parse(text)
    } catch (_error) {
        return undefined
    }
}

function toReportSummary(report: any): any {
    const failedResults = Array.isArray(report?.resultsList)
        ? report.resultsList
            .filter((result: any) => result?.status !== 'SUCCESS')
            .map((result: any) => ({
                name: result.name,
                status: result.status,
                result: result.result,
                connection: result.connection,
                action: result.action,
                exception: result.actual?.exception,
            }))
        : []

    return {
        summary: report?.summary,
        rtcProviderNames: report?.rtcProviderNames,
        failedResults,
    }
}

function summarizeRun(run: ValidationRun, verbose: boolean): void {
    console.log('')
    console.log(`=== ${run.transport} ${run.mode} ===`)
    console.log(`status: ${run.success ? 'SUCCESS' : 'FAILURE'} (${run.code})`)

    const maskedStdout = maskString(run.stdout)
    const maskedStderr = maskString(run.stderr)
    const parsed = tryParseJson(run.stdout)

    if (parsed !== undefined) {
        const masked = maskValue(parsed)
        console.log(JSON.stringify(verbose ? masked : toReportSummary(masked), null, 2))
    } else if (maskedStdout.trim().length > 0) {
        console.log(maskedStdout)
    }

    if (maskedStderr.trim().length > 0) {
        console.error(maskedStderr)
    }
}

async function recordRun(run: ValidationRun, recordDir: string): Promise<void> {
    await Deno.mkdir(recordDir, { recursive: true })

    const parsed = tryParseJson(run.stdout)
    const artifact = {
        mode: run.mode,
        transport: run.transport,
        scenarioPath: run.scenarioPath,
        success: run.success,
        code: run.code,
        report: parsed === undefined ? undefined : maskValue(parsed),
        stdout: parsed === undefined ? maskString(run.stdout) : undefined,
        stderr: maskString(run.stderr),
    }
    const filename = `rallar-browser-${run.transport.replace('.', '-')}-${run.mode}.json`
    await Deno.writeTextFile(
        `${recordDir.replace(/\/$/, '')}/${filename}`,
        JSON.stringify(artifact, null, 2),
    )
}

async function runScenario(
    mode: Exclude<ValidationMode, 'both'>,
    transport: Exclude<ValidationTransport, 'both'>,
): Promise<ValidationRun> {
    const replacements = toReplacementMap()
    const scenarioPath = repoRelativePath(SCENARIOS[transport])
    const args = [
        'run',
        '-A',
        repoRelativePath(SCENARIO_CLI),
        '-c',
        scenarioPath,
        '-r',
        toReplacementArg(replacements),
    ]

    if (mode === 'dry-run') {
        args.push('-n')
    }

    const output = await new Deno.Command(Deno.execPath(), {
        args,
        cwd: filePath(REPO_ROOT),
        stdout: 'piped',
        stderr: 'piped',
    }).output()

    const decoder = new TextDecoder()
    return {
        mode,
        transport,
        scenarioPath,
        success: output.success,
        code: output.code,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
        parsedReport: tryParseJson(decoder.decode(output.stdout)),
    }
}

async function main(): Promise<void> {
    const options = parseArgs(Deno.args)
    if (options.help) {
        console.log(usage())
        return
    }

    assertLiveEnvironmentIfNeeded(options)

    const runs = selectedModes(options.mode)
        .flatMap(mode => selectedTransports(options.transport).map(transport => ({
            mode,
            transport,
        })))

    const results: ValidationRun[] = []
    for (const run of runs) {
        const result = await runScenario(run.mode, run.transport)
        results.push(result)
        summarizeRun(result, options.verbose)

        if (options.recordDir) {
            await recordRun(result, options.recordDir)
        }

        if (!result.success && !options.continueOnFailure) {
            break
        }
    }

    const failed = results.filter(result => !result.success)
    console.log('')
    console.log(`Validated ${results.length} run(s), failures: ${failed.length}`)

    if (failed.length > 0) {
        Deno.exit(1)
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    Deno.exit(1)
})
