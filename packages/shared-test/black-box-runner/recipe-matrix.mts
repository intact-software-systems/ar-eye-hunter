/// <reference lib="deno.ns" />
// deno-lint-ignore-file no-explicit-any

type MatrixMode = 'dry-run' | 'run'

type HttpServiceRequirement = {
    name: string
    env: string
    default?: string
}

type MatrixRequirement = {
    env?: string[]
    httpServices?: HttpServiceRequirement[]
    playwright?: boolean
}

type MatrixEntry = {
    id: string
    recipe: string
    category: string
    mode: MatrixMode
    profiles: string[]
    expectedExitCode: number
    artifactName?: string
    env?: Record<string, string>
    requires?: MatrixRequirement
    description?: string
}

type MatrixFile = {
    version: number
    description?: string
    entries: MatrixEntry[]
}

type CliOptions = {
    profile: string
    artifactDir?: string
    ids: string[]
    list: boolean
    requireGates: boolean
    failFast: boolean
    verbose: boolean
    help: boolean
}

type SkippedMatrixRun = {
    id: string
    recipe: string
    status: 'SKIPPED'
    reasons: string[]
}

type ExecutedMatrixRun = {
    id: string
    recipe: string
    status: 'PASSED' | 'FAILED'
    expectedExitCode: number
    code: number
    durationMs: number
    artifactDir?: string
    summary?: any
    stdout?: string
    stderr?: string
}

type MatrixRun = SkippedMatrixRun | ExecutedMatrixRun

const SCRIPT_DIR = new URL('.', import.meta.url)
const REPO_ROOT = new URL('../../../', SCRIPT_DIR)
const MATRIX_FILE = new URL('./recipe-matrix.json', SCRIPT_DIR)
const SCENARIO_CLI = new URL('./scenario-black-box.ts', SCRIPT_DIR)

function usage(): string {
    return [
        'Usage:',
        '  deno run -A packages/shared-test/black-box-runner/recipe-matrix.mts [options]',
        '',
        'Options:',
        '  --profile=<name>              quick, dry, deterministic, soak, traffic, parallel, failure-diagnostics, live, live-soak, live-traffic, live-parallel, rallar-server-live, browser-live, remote-live, signaling-live. Default: quick',
        '  --id=<entry-id>               Run one entry. Can be repeated.',
        '  --artifact-dir=<dir>          Write per-entry scenario artifacts and matrix-summary.json.',
        '  --list                        Print the selected matrix entries and exit.',
        '  --require-gates               Treat skipped live gates as failures.',
        '  --fail-fast                   Stop after the first failed or skipped required entry.',
        '  --verbose                     Print command output for every executed entry.',
        '  --help                        Print this help.',
    ].join('\n')
}

function parseArgs(args: string[]): CliOptions {
    const options: CliOptions = {
        profile: 'quick',
        ids: [],
        list: false,
        requireGates: false,
        failFast: false,
        verbose: false,
        help: false,
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        const [name, inlineValue] = arg.includes('=')
            ? arg.split(/=(.*)/s, 2)
            : [arg, undefined]
        const nextValue = (): string => {
            const value = inlineValue ?? args[++i]
            if (!value || value.startsWith('--')) {
                throw new Error('Missing value for ' + name)
            }
            return value
        }

        switch (name) {
            case '--help':
            case '-h':
                options.help = true
                break
            case '--profile':
                options.profile = nextValue()
                break
            case '--id':
                options.ids.push(nextValue())
                break
            case '--artifact-dir':
            case '--artifacts':
            case '--record-dir':
                options.artifactDir = nextValue()
                break
            case '--list':
                options.list = true
                break
            case '--require-gates':
                options.requireGates = true
                break
            case '--fail-fast':
                options.failFast = true
                break
            case '--verbose':
                options.verbose = true
                break
            default:
                throw new Error('Unknown argument: ' + arg)
        }
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

async function readMatrix(): Promise<MatrixFile> {
    return JSON.parse(await Deno.readTextFile(MATRIX_FILE))
}

function selectedEntries(matrix: MatrixFile, options: CliOptions): MatrixEntry[] {
    const byProfile = matrix.entries.filter(entry => entry.profiles.includes(options.profile))
    if (options.ids.length === 0) {
        return byProfile
    }

    const ids = new Set(options.ids)
    return matrix.entries.filter(entry => ids.has(entry.id))
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await Deno.stat(path)
        return true
    } catch (_error) {
        return false
    }
}

function envValue(name: string): string | undefined {
    const value = Deno.env.get(name)
    return value && value.length > 0 ? value : undefined
}

async function checkHttpService(requirement: HttpServiceRequirement): Promise<string | undefined> {
    const url = envValue(requirement.env) ?? requirement.default
    if (!url) {
        return `${requirement.name} URL is missing: set ${requirement.env}`
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1500)
    try {
        await fetch(url, {
            method: 'GET',
            signal: controller.signal,
        })
        return undefined
    } catch (error) {
        const source = envValue(requirement.env) ? requirement.env : `${requirement.env} default`
        const message = error instanceof Error ? error.message : String(error)
        return `${requirement.name} unavailable at ${url} from ${source}: ${message}`
    } finally {
        clearTimeout(timeout)
    }
}

async function hasPlaywrightCli(): Promise<boolean> {
    const output = await new Deno.Command('npx', {
        args: ['playwright', '--version'],
        cwd: filePath(REPO_ROOT),
        stdout: 'null',
        stderr: 'null',
    }).output()

    return output.success
}

async function gateReasons(entry: MatrixEntry): Promise<string[]> {
    const requires = entry.requires
    if (!requires) {
        return []
    }

    const reasons: string[] = []
    for (const name of requires.env ?? []) {
        if (!envValue(name)) {
            reasons.push(`missing environment variable ${name}`)
        }
    }

    for (const service of requires.httpServices ?? []) {
        const reason = await checkHttpService(service)
        if (reason) {
            reasons.push(reason)
        }
    }

    if (requires.playwright === true && !(await hasPlaywrightCli())) {
        reasons.push('Playwright CLI is unavailable; run npm install and install Playwright browsers for live browser recipes')
    }

    return reasons
}

function entryArtifactDir(options: CliOptions, entry: MatrixEntry): string | undefined {
    if (!options.artifactDir) {
        return undefined
    }

    return [
        options.artifactDir.replace(/\/+$/, ''),
        entry.artifactName ?? entry.id,
    ].join('/')
}

function commandArgs(entry: MatrixEntry, artifactDir?: string): string[] {
    const recipeUrl = new URL(entry.recipe, SCRIPT_DIR)
    const args = [
        'run',
        '-A',
        repoRelativePath(SCENARIO_CLI),
        '-c',
        repoRelativePath(recipeUrl),
    ]

    if (entry.mode === 'dry-run') {
        args.push('--dry-run')
    }

    if (artifactDir) {
        args.push('--artifact-dir=' + artifactDir)
    }

    return args
}

function parseReportSummary(stdout: string): any {
    try {
        return JSON.parse(stdout)?.summary
    } catch (_error) {
        return undefined
    }
}

async function runEntry(entry: MatrixEntry, options: CliOptions): Promise<MatrixRun> {
    const recipePath = filePath(new URL(entry.recipe, SCRIPT_DIR))
    if (!(await fileExists(recipePath))) {
        return {
            id: entry.id,
            recipe: entry.recipe,
            status: 'SKIPPED',
            reasons: [`recipe file does not exist: ${entry.recipe}`],
        }
    }

    const reasons = await gateReasons(entry)
    if (reasons.length > 0) {
        return {
            id: entry.id,
            recipe: entry.recipe,
            status: 'SKIPPED',
            reasons,
        }
    }

    const artifactDir = entryArtifactDir(options, entry)
    const startedAt = Date.now()
    const output = await new Deno.Command(Deno.execPath(), {
        args: commandArgs(entry, artifactDir),
        cwd: filePath(REPO_ROOT),
        env: {
            ...Deno.env.toObject(),
            ...(entry.env ?? {}),
        },
        stdout: 'piped',
        stderr: 'piped',
    }).output()
    const endedAt = Date.now()
    const stdout = new TextDecoder().decode(output.stdout)
    const stderr = new TextDecoder().decode(output.stderr)
    const passed = output.code === entry.expectedExitCode

    return {
        id: entry.id,
        recipe: entry.recipe,
        status: passed ? 'PASSED' : 'FAILED',
        expectedExitCode: entry.expectedExitCode,
        code: output.code,
        durationMs: endedAt - startedAt,
        artifactDir,
        summary: parseReportSummary(stdout),
        ...(options.verbose || !passed ? { stdout, stderr } : {}),
    }
}

async function writeMatrixSummary(options: CliOptions, runs: MatrixRun[]): Promise<void> {
    if (!options.artifactDir) {
        return
    }

    await Deno.mkdir(options.artifactDir, { recursive: true })
    await Deno.writeTextFile(
        options.artifactDir.replace(/\/+$/, '') + '/matrix-summary.json',
        JSON.stringify({
            generatedAtEpochMs: Date.now(),
            profile: options.profile,
            requireGates: options.requireGates,
            runs,
            summary: summarize(runs),
        }, null, 2),
    )
}

function summarize(runs: MatrixRun[]): Record<string, number> {
    return runs.reduce<Record<string, number>>((summary, run) => {
        summary[run.status] = (summary[run.status] ?? 0) + 1
        return summary
    }, {
        PASSED: 0,
        FAILED: 0,
        SKIPPED: 0,
    })
}

function printList(entries: MatrixEntry[]): void {
    entries.forEach(entry => {
        console.log(`${entry.id} | ${entry.mode} | ${entry.recipe} | ${entry.profiles.join(',')}`)
    })
}

function printRun(run: MatrixRun): void {
    if (run.status === 'SKIPPED') {
        console.log(`SKIP ${run.id}: ${run.reasons.join('; ')}`)
        return
    }

    const expectation = run.expectedExitCode === run.code
        ? ''
        : ` expected=${run.expectedExitCode}`
    const summary = run.summary
        ? ` success=${run.summary.success ?? '?'} failure=${run.summary.failure ?? '?'}`
        : ''
    console.log(`${run.status} ${run.id}: exit=${run.code}${expectation} durationMs=${run.durationMs}${summary}`)

    if (run.stdout?.trim()) {
        console.log(run.stdout)
    }

    if (run.stderr?.trim()) {
        console.error(run.stderr)
    }
}

async function main(): Promise<void> {
    const options = parseArgs(Deno.args)
    if (options.help) {
        console.log(usage())
        return
    }

    const matrix = await readMatrix()
    const entries = selectedEntries(matrix, options)
    if (entries.length === 0) {
        throw new Error('No recipe matrix entries selected for profile ' + options.profile)
    }

    if (options.list) {
        printList(entries)
        return
    }

    const runs: MatrixRun[] = []
    for (const entry of entries) {
        const run = await runEntry(entry, options)
        runs.push(run)
        printRun(run)

        const requiredSkip = run.status === 'SKIPPED' && options.requireGates
        if ((run.status === 'FAILED' || requiredSkip) && options.failFast) {
            break
        }
    }

    await writeMatrixSummary(options, runs)

    const summary = summarize(runs)
    console.log(`Matrix profile ${options.profile}: passed=${summary.PASSED} failed=${summary.FAILED} skipped=${summary.SKIPPED}`)

    if (summary.FAILED > 0 || (options.requireGates && summary.SKIPPED > 0)) {
        Deno.exit(1)
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    Deno.exit(1)
})
