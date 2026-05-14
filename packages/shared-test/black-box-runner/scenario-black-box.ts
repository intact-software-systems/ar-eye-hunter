import * as sync from './execute-black-box.ts'
import * as scenarioAlgorithms from './scenario-algorithm.ts'
import utils from './utils.ts'

import {Command} from "https://deno.land/x/cmd@v1.2.0/commander/index.ts"

const program = new Command()

program
    .requiredOption('-c, --config <config>', 'Config file in json format', value => value)
    .option('-w, --workingDirectory <workingDirectory>', 'Working directory')
    .option('-r, --replace <replace>', 'Replace tags. Example: tag1:=value,tag2:=value . No space in string')
    .option('-e, --execution <execution>', 'Execution style dry or wet. Default is wet. -e dry|wet')
    .option('-n, --dry-run', 'Execute in dry-run mode without invoking transports/providers')

program.on('-h, --help', () => {
    console.log('')
    console.log('Example calls:')
    console.log('  $ scenario-generate --config config.json')
    console.log('  $ scenario-generate -c config.json')
    console.log('  $ scenario-generate -c config.json -e dry')
    console.log('  $ scenario-generate -c config.json --dry-run')
    console.log('  $ scenario-generate -c config.json -n')
    console.log('  $ scenario-generate --config config.json --replace url:=http://localhost:8080/led/api/v1,valuDate:=2022-10-01')
    console.log('  $ scenario-generate -c config.json -r url:=http://localhost:8080/led/api/v1,valuDate:=2022-10-01')
    console.log('  $ scenario-generate -c config.json -w ./test-data -r url:=http://localhost:8080/led/api/v1,valuDate:=2022-10-01')
})

program.parse(process.argv)

utils.setWorkingDirectory(program.opts().workingDirectory || '.')

type JsonRecord = Record<string, unknown>

type ScenarioCliConfig = JsonRecord & {
    replace?: JsonRecord
    variables?: JsonRecord
    execution?: JsonRecord
    steps?: Array<JsonRecord>
}

const input = utils.openFile(program.opts().config) as ScenarioCliConfig

const cliReplacements = utils.inputReplacesToJson(program.opts().replace)

input.replace = {
    ...asRecord(input.replace),
    ...cliReplacements,
}

input.variables = {
    ...asRecord(input.variables),
    ...asRecord(input.replace),
    ...cliReplacements,
}

function replaceVariables<T>(data: T, variables: Record<string, unknown> = {}): T {
    let text = JSON.stringify(data)

    Object.entries(variables)
        .forEach(([key, value]) => {
            text = text.replaceAll('{' + key + '}', String(value))
        })

    return JSON.parse(text)
}

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : {}
}

function joinUrl(baseUrl: unknown, path: unknown): unknown {
    if (typeof path !== 'string') {
        return path
    }

    if (!baseUrl || typeof baseUrl !== 'string') {
        return path
    }

    if (path.startsWith('http://') || path.startsWith('https://')) {
        return path
    }

    return baseUrl.replace(/\/$/, '') + '/' + path.replace(/^\//, '')
}

function connectionRequestDefaults(connection: JsonRecord): JsonRecord {
    const {
        headers: _headers,
        resilience: _resilience,
        baseUrl: _baseUrl,
        url: _url,
        ...requestDefaults
    } = connection

    return requestDefaults
}

function toConnection(config: Record<string, unknown>, step: Record<string, unknown>): JsonRecord {
    const connections = asRecord(config.connections)
    const connectionName = step.connection

    if (typeof connectionName !== 'string') {
        return {}
    }

    return asRecord(connections[connectionName])
}

function withDefaultsAndConnection(
    step: Record<string, unknown>,
    config: Record<string, unknown>,
): Record<string, unknown> {
    const defaults = asRecord(config.defaults)
    const connection = toConnection(config, step)
    const request = asRecord(step.request)
    const expect = asRecord(step.expect || step.response)

    const defaultHeaders = asRecord(defaults.headers)
    const connectionHeaders = asRecord(connection.headers)
    const requestHeaders = asRecord(request.headers)

    const connectionBaseUrl = connection.baseUrl || defaults.baseUrl
    const path = joinUrl(connectionBaseUrl, request.path || request.url || connection.url)

    return {
        ...step,
        type: step.type || connection.type || defaults.type || 'http',
        request: {
            ...connectionRequestDefaults(connection),
            ...request,
            path,
            method: request.method || defaults.method || 'GET',
            timeoutMs: request.timeoutMs || connection.timeoutMs || defaults.timeoutMs,
            resilience: {
                ...asRecord(defaults.resilience),
                ...asRecord(connection.resilience),
                ...asRecord(step.resilience),
                ...asRecord(request.resilience),
            },
            headers: {
                ...defaultHeaders,
                ...connectionHeaders,
                ...requestHeaders,
            },
        },
        expect: {
            ...expect,
            comparison: expect.comparison || defaults.comparison,
            ignoreJsonKeys: expect.ignoreJsonKeys || defaults.ignoreJsonKeys,
            ignoreJsonPaths: expect.ignoreJsonPaths || defaults.ignoreJsonPaths,
        },
    }
}

function toExecutableStep(
    step: Record<string, unknown>,
    index: number,
    inferredInputs: string[] = [],
): Record<string, unknown> {
    const request = step.request as Record<string, unknown> || {}
    const expect = step.expect as Record<string, unknown> || step.response as Record<string, unknown> || {}

    const stepType = String(step.type || 'http').toLowerCase()
    const technology = stepType.startsWith('assert')
        ? 'ASSERT'
        : stepType.startsWith('set') || stepType.startsWith('derive')
            ? 'SET'
            : stepType.startsWith('ws')
                ? 'WS'
                : stepType.startsWith('rtc') || stepType.startsWith('webrtc')
                    ? 'RTC'
                    : 'HTTP'

    const action = stepType.includes('.')
        ? stepType.split('.')[1]
        : request.action || step.action

    return {
        [technology]: {
            request: {
                ...request,
                action,
                connection: step.connection || request.connection,
                method: request.method || 'GET',
                path: request.path || request.url,
                input: request.input || step.input || inferredInputs,
                output: request.output || step.output,
                value: step.value !== undefined ? step.value : request.value,
                scenarioExecutionNumber: 1,
                interactionExecutionNumber: index + 1,
                repeatIndex: step.repeatIndex,
            },
            response: {
                ...expect,
                actual: step.actual !== undefined ? step.actual : expect.actual,
                statusCode: expect.statusCode !== undefined ? expect.statusCode : expect.status,
            },
        },
        [String(step.name || 'step-' + (index + 1))]: step,
    }
}

function toPlaceholderNames(data: unknown): string[] {
    const text = JSON.stringify(data)
    const matches = text.matchAll(/\{([^{}]+)}/g)

    return [...matches]
        .map(match => match[1])
        .map(path => path.split('.')[0])
        .filter(name => name.length > 0)
}

function toStepOutputName(step: Record<string, unknown>): string | undefined {
    const request = step.request as Record<string, unknown> || {}
    const output = request.output || step.output

    return typeof output === 'string' && output.length > 0
        ? output
        : undefined
}

function toKnownOutputNames(steps: Array<Record<string, unknown>>, currentIndex: number): string[] {
    return steps
        .slice(0, currentIndex)
        .map(toStepOutputName)
        .filter((name): name is string => name !== undefined)
}

function toInferredInputs(
    step: Record<string, unknown>,
    steps: Array<Record<string, unknown>>,
    currentIndex: number,
): string[] {
    const knownOutputs = toKnownOutputNames(steps, currentIndex)
    const placeholderNames = toPlaceholderNames(step)

    return [...new Set(
        placeholderNames.filter(name => knownOutputs.includes(name))
    )]
}

function toRepeatedSteps(steps: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return steps.flatMap(step => {
        const repeat = Number.parseInt(String(step.repeat ?? '1'))

        return new Array(Number.isFinite(repeat) && repeat > 0 ? repeat : 1)
            .fill(0)
            .map((_ignored, repeatIndex) => ({
                ...step,
                repeatIndex: repeatIndex + 1,
            }))
    })
}

function toExecutableInteractions(config: ScenarioCliConfig): unknown[] {
    const normalizedConfig = replaceVariables(config, config.variables as Record<string, unknown>)

    if (Array.isArray(normalizedConfig.steps)) {
        const steps = toRepeatedSteps(normalizedConfig.steps as Array<Record<string, unknown>>)
            .map((step: Record<string, unknown>) => withDefaultsAndConnection(step, normalizedConfig as Record<string, unknown>))

        return steps
            .map((step: Record<string, unknown>, index: number) => {
                return toExecutableStep(
                    step,
                    index,
                    toInferredInputs(step, steps, index),
                )
            })
    }

    return scenarioAlgorithms.createScenarios(normalizedConfig).flatMap(a => a)
}

const scenarioJson = toExecutableInteractions(input)

const executionConfig = asRecord(input.execution)
const cliOptions = program.opts()

const failFast = executionConfig.failFast !== false
const printDryExecutableInteractions = cliOptions.execution && cliOptions.execution.toLowerCase().includes('dry')
const dryRun = cliOptions.dryRun === true || executionConfig.dryRun === true

if (printDryExecutableInteractions) {
    console.log(JSON.stringify(scenarioJson, null, 2))
}
else {
    sync.executeBlackBox(scenarioJson, 0, {
            failFast,
            dryRun,
            variables: input.variables || {},
        })
        .then(report => {
            console.log(JSON.stringify(report, null, 2))

            if (report?.summary?.failure && report.summary.failure > 0) {
                Deno.exit(1)
            }
        })
        .catch(e => {
            console.error(e)
            Deno.exit(1)
        })
}