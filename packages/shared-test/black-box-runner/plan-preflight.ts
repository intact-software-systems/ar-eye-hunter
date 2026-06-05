import {
    validateBlackBoxRunnerScenarioRecipe,
} from './schema.ts'
import type {
    JsonSchemaValidationIssue,
} from '../rallar-bb-test/schema.ts'

type JsonRecord = Record<string, unknown>

export type BlackBoxRunnerPreflightProfile = 'compat' | 'strict'
export type BlackBoxRunnerPreflightSeverity = 'error' | 'warning'

export type BlackBoxRunnerEnvRequirement = Readonly<{
    variableName: string
    envName: string
    required: boolean
    secret: boolean
    hasValue: boolean
    hasDefault: boolean
    hasFallback: boolean
    source: 'env' | 'default' | 'fallback' | 'missing' | 'unset'
}>

export type BlackBoxRunnerPreflightIssue = Readonly<{
    severity: BlackBoxRunnerPreflightSeverity
    code: string
    message: string
    path?: string
}>

export type BlackBoxRunnerPreflightOperation = Readonly<{
    name: string
    transport: string
    action?: string
    connection?: string
    provider?: string
    path?: string
    group?: string
    groupCount?: number
    interactionExecutionNumber?: number
    repeatIndex?: number
}>

export type BlackBoxRunnerPlanPreflight = Readonly<{
    schemaVersion: 1
    ok: boolean
    profile: BlackBoxRunnerPreflightProfile
    summary: Readonly<{
        generatedOperationCount: number
        topLevelOperationCount: number
        parallelGroupCount: number
        estimatedArtifactResultRecords: number
        estimatedArtifactEventRecords: number
        estimatedArtifactJsonBytes: number
        postRunAssertionCount: number
        includeCount: number
    }>
    includes: Readonly<{
        resolved: readonly JsonRecord[]
    }>
    providerModes: readonly string[]
    liveServiceRequirements: readonly string[]
    env: Readonly<{
        required: readonly BlackBoxRunnerEnvRequirement[]
        missing: readonly BlackBoxRunnerEnvRequirement[]
    }>
    connections: Readonly<{
        defined: readonly string[]
        referenced: readonly string[]
        missing: readonly string[]
    }>
    stepReferences: Readonly<{
        defined: readonly string[]
        referenced: readonly Readonly<{ name: string; path: string }>[]
        missing: readonly Readonly<{ name: string; path: string }>[]
    }>
    outputs: Readonly<{
        produced: readonly string[]
        consumed: readonly string[]
        missingConsumed: readonly string[]
    }>
    redactions: Readonly<{
        sources: readonly Readonly<{ kind: 'variable' | 'output'; name: string; redactAs?: string }>[]
    }>
    trafficPlan?: Readonly<{
        enabled: boolean
        replay: boolean
        seed?: number
        decisionCount: number
        stepCount: number
    }>
    operations: readonly BlackBoxRunnerPreflightOperation[]
    issues: readonly BlackBoxRunnerPreflightIssue[]
}>

export type BlackBoxRunnerPreflightInput = Readonly<{
    rawConfig: JsonRecord
    expandedConfig?: JsonRecord
    executableInteractions?: readonly unknown[]
    envRequirements?: readonly BlackBoxRunnerEnvRequirement[]
    trafficPlanArtifact?: JsonRecord
    profile?: BlackBoxRunnerPreflightProfile
    expansionError?: unknown
}>

type Redaction = {
    name: string
    value: string
}

const TRANSPORT_KEYS = ['HTTP', 'MQ', 'WS', 'RTC', 'WEBRTC', 'ASSERT', 'SET', 'PARALLEL'] as const
const RESERVED_PLACEHOLDER_ROOTS = new Set([
    'loop',
    'traffic',
    'variables',
    'outputs',
    'results',
    'resultsList',
    'resultsByName',
    'process',
])

export function collectBlackBoxRunnerEnvRequirements(
    config: JsonRecord,
    environment: Record<string, string | undefined> = {},
): readonly BlackBoxRunnerEnvRequirement[] {
    const variables = asRecord(config.variables)

    return Object.entries(variables)
        .flatMap(([variableName, value]) => {
            if (!isEnvVariableDescriptor(value)) {
                return []
            }

            const descriptor = value as JsonRecord
            const envName = String(descriptor.env ?? descriptor.fromEnv)
            const envValue = environment[envName]
            const hasValue = envValue !== undefined && (envValue.length > 0 || descriptor.allowEmpty === true)
            const hasDefault = descriptor.default !== undefined
            const hasFallback = descriptor.fallback !== undefined
            const required = descriptor.required === true
            const source = hasValue
                ? 'env'
                : hasDefault
                    ? 'default'
                    : hasFallback
                        ? 'fallback'
                        : required
                            ? 'missing'
                            : 'unset'

            return [{
                variableName,
                envName,
                required,
                secret: descriptor.secret === true || descriptor.redact === true,
                hasValue,
                hasDefault,
                hasFallback,
                source,
            }]
        })
}

export function resolveBlackBoxRunnerVariablesForPreflight(
    rawVariables: JsonRecord = {},
    environment: Record<string, string | undefined> = {},
    secretVariables: unknown = [],
): { variables: JsonRecord; redactions: Redaction[] } {
    const secrets = toSecretNameSet(secretVariables)
    const variables: JsonRecord = {}
    const redactions: Redaction[] = []

    Object.entries(rawVariables)
        .forEach(([key, value]) => {
            if (!isEnvVariableDescriptor(value)) {
                variables[key] = value
                if (secrets.has(key)) {
                    addRedaction(redactions, key, value)
                }
                return
            }

            const descriptor = value as JsonRecord
            const envName = String(descriptor.env ?? descriptor.fromEnv)
            const envValue = environment[envName]
            const hasEnvValue = envValue !== undefined && (envValue.length > 0 || descriptor.allowEmpty === true)
            const fallbackValue = descriptor.default !== undefined
                ? descriptor.default
                : descriptor.fallback
            const resolvedValue = hasEnvValue
                ? envValue
                : fallbackValue !== undefined
                    ? fallbackValue
                    : `<missing:${envName}>`

            variables[key] = resolvedValue

            if (descriptor.secret === true || descriptor.redact === true || secrets.has(key)) {
                addRedaction(redactions, String(descriptor.redactAs || key), resolvedValue)
            }
        })

    return {
        variables,
        redactions,
    }
}

export function explainBlackBoxRunnerPlan(input: BlackBoxRunnerPreflightInput): BlackBoxRunnerPlanPreflight {
    const profile = input.profile ?? 'compat'
    const rawConfig = input.rawConfig
    const expandedConfig = input.expandedConfig ?? rawConfig
    const executableInteractions = input.executableInteractions ?? []
    const operations = flattenExecutableOperations(executableInteractions)
    const schemaValidation = validateBlackBoxRunnerScenarioRecipe(rawConfig)
    const envRequirements = input.envRequirements ?? collectBlackBoxRunnerEnvRequirements(rawConfig)
    const missingEnv = envRequirements.filter(requirement => requirement.required && requirement.source === 'missing')
    const connectionSummary = connectionPreflight(rawConfig, operations)
    const stepReferences = stepReferencePreflight(rawConfig)
    const outputSummary = outputPreflight(rawConfig, expandedConfig, operations)
    const redactions = redactionPreflight(rawConfig)
    const includes = includePreflight(expandedConfig)
    const strictIssues = profile === 'strict'
        ? strictProfileIssues(rawConfig, operations)
        : []
    const schemaIssues = schemaValidation.ok
        ? []
        : schemaValidation.errors.map(schemaIssueToPreflightIssue)
    const expansionIssue = input.expansionError === undefined
        ? []
        : [{
            severity: 'error' as const,
            code: 'PLAN_EXPANSION_FAILED',
            message: errorMessage(input.expansionError),
        }]
    const issues = [
        ...schemaIssues,
        ...missingEnv.map(requirement => ({
            severity: 'error' as const,
            code: 'MISSING_ENV',
            message: `Missing required environment variable ${requirement.envName} for variable ${requirement.variableName}.`,
            path: `variables.${requirement.variableName}`,
        })),
        ...connectionSummary.missing.map(connection => ({
            severity: 'error' as const,
            code: 'MISSING_CONNECTION',
            message: `Step references missing connection ${connection}.`,
            path: 'connections',
        })),
        ...stepReferences.missing.map(reference => ({
            severity: 'error' as const,
            code: 'MISSING_STEP_REFERENCE',
            message: `Recipe references missing step ${reference.name}.`,
            path: reference.path,
        })),
        ...outputSummary.missingConsumed.map(output => ({
            severity: 'warning' as const,
            code: 'MISSING_OUTPUT_REFERENCE',
            message: `Placeholder references ${output}, but no earlier output with that name is produced.`,
            path: 'steps',
        })),
        ...strictIssues,
        ...expansionIssue,
    ]
    const parallelGroupCount = operations.filter(operation => operation.transport === 'PARALLEL').length === 0
        ? 0
        : operations
            .filter(operation => operation.transport === 'PARALLEL')
            .reduce((sum, operation) => sum + (operation.groupCount ?? 0), 0)
    const estimatedArtifactJsonBytes = JSON.stringify({
        executableInteractions,
        trafficPlan: input.trafficPlanArtifact,
    }).length

    return {
        schemaVersion: 1,
        ok: issues.every(issue => issue.severity !== 'error'),
        profile,
        summary: {
            generatedOperationCount: operations.length,
            topLevelOperationCount: executableInteractions.length,
            parallelGroupCount,
            estimatedArtifactResultRecords: operations.length,
            estimatedArtifactEventRecords: Math.max(operations.length, operations.length * 2),
            estimatedArtifactJsonBytes,
            postRunAssertionCount: postRunAssertionCount(rawConfig),
            includeCount: includes.resolved.length,
        },
        includes,
        providerModes: providerModes(rawConfig, operations),
        liveServiceRequirements: liveServiceRequirements(rawConfig, operations, input.trafficPlanArtifact),
        env: {
            required: envRequirements.filter(requirement => requirement.required),
            missing: missingEnv,
        },
        connections: connectionSummary,
        stepReferences,
        outputs: outputSummary,
        redactions,
        trafficPlan: trafficPlanPreflight(input.trafficPlanArtifact),
        operations,
        issues,
    }
}

function schemaIssueToPreflightIssue(issue: JsonSchemaValidationIssue): BlackBoxRunnerPreflightIssue {
    return {
        severity: 'error',
        code: 'SCHEMA',
        message: issue.message,
        path: issue.path,
    }
}

function isRecord(value: unknown): value is JsonRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): JsonRecord {
    return isRecord(value)
        ? value
        : {}
}

function includePreflight(expandedConfig: JsonRecord): BlackBoxRunnerPlanPreflight['includes'] {
    const includeMetadata = asRecord(expandedConfig.includeMetadata)
    const includes = Array.isArray(includeMetadata.includes)
        ? includeMetadata.includes.filter(isRecord)
        : []

    return {
        resolved: includes,
    }
}

function isEnvVariableDescriptor(value: unknown): value is JsonRecord {
    const record = asRecord(value)
    return typeof record.env === 'string' || typeof record.fromEnv === 'string'
}

function toSecretNameSet(secretVariables: unknown): Set<string> {
    if (Array.isArray(secretVariables)) {
        return new Set(secretVariables.map(String))
    }

    if (typeof secretVariables === 'string') {
        return new Set(
            secretVariables
                .split(',')
                .map(value => value.trim())
                .filter(value => value.length > 0),
        )
    }

    return new Set()
}

function addRedaction(redactions: Redaction[], name: string, value: unknown): void {
    if (value === undefined || value === null) {
        return
    }

    const text = String(value)
    if (text.length <= 0 || text.startsWith('<missing:')) {
        return
    }

    if (!redactions.some(redaction => redaction.name === name && redaction.value === text)) {
        redactions.push({
            name,
            value: text,
        })
    }
}

function uniqueValues(values: readonly string[]): readonly string[] {
    return [...new Set(values.filter(value => value.length > 0))].sort()
}

function transportKey(interaction: unknown): string | undefined {
    const record = asRecord(interaction)
    return TRANSPORT_KEYS.find(key => record[key] !== undefined)
}

function interactionName(interaction: unknown): string {
    const record = asRecord(interaction)
    return Object.keys(record)
        .find(key => !TRANSPORT_KEYS.includes(key as typeof TRANSPORT_KEYS[number])) ?? 'unnamed'
}

function executableRequest(interaction: unknown): JsonRecord {
    const key = transportKey(interaction)
    return key ? asRecord(asRecord(asRecord(interaction)[key]).request) : {}
}

function flattenExecutableOperations(
    interactions: readonly unknown[],
    group?: string,
): readonly BlackBoxRunnerPreflightOperation[] {
    return interactions.flatMap(interaction => {
        const transport = transportKey(interaction) ?? 'UNKNOWN'
        const request = executableRequest(interaction)
        const operation: BlackBoxRunnerPreflightOperation = {
            name: interactionName(interaction),
            transport,
            action: stringValue(request.action),
            connection: stringValue(request.connection),
            provider: stringValue(request.provider ?? request.remoteProvider ?? asRecord(request.control).provider),
            path: stringValue(request.path ?? request.url),
            group,
            interactionExecutionNumber: numberValue(request.interactionExecutionNumber),
            repeatIndex: numberValue(request.repeatIndex),
        }

        if (transport !== 'PARALLEL') {
            return [operation]
        }

        const groups = Array.isArray(request.groups)
            ? request.groups
            : []
        const children = groups.flatMap(groupSpec => {
            const groupRecord = asRecord(groupSpec)
            return flattenExecutableOperations(
                Array.isArray(groupRecord.steps) ? groupRecord.steps : [],
                stringValue(groupRecord.name),
            )
        })

        return [
            {
                ...operation,
                groupCount: groups.length,
            },
            ...children,
        ]
    })
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0
        ? value
        : undefined
}

function numberValue(value: unknown): number | undefined {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
}

function connectionPreflight(
    rawConfig: JsonRecord,
    operations: readonly BlackBoxRunnerPreflightOperation[],
): BlackBoxRunnerPlanPreflight['connections'] {
    const defined = uniqueValues(Object.keys(asRecord(rawConfig.connections)))
    const referenced = uniqueValues(operations
        .map(operation => operation.connection)
        .filter((connection): connection is string => Boolean(connection)))
    const definedSet = new Set(defined)

    return {
        defined,
        referenced,
        missing: referenced.filter(connection => !definedSet.has(connection)),
    }
}

function stepReferencePreflight(rawConfig: JsonRecord): BlackBoxRunnerPlanPreflight['stepReferences'] {
    const steps = Array.isArray(rawConfig.steps)
        ? rawConfig.steps.map(asRecord)
        : []
    const defined = uniqueValues(steps.map((step, index) => stepName(step, index)))
    const definedSet = new Set(defined)
    const references: Array<{ name: string; path: string }> = []
    const execution = asRecord(rawConfig.execution)
    const soak = asRecord(execution.soak)
    const trafficPlan = asRecord(execution.trafficPlan || rawConfig.trafficPlan)

    collectStepNameReferences(references, soak.setupSteps ?? soak.setup, 'execution.soak.setupSteps')
    collectStepNameReferences(references, soak.loopSteps ?? soak.loop ?? soak.steps, 'execution.soak.loopSteps')
    collectStepNameReferences(references, soak.cleanupSteps ?? soak.cleanup, 'execution.soak.cleanupSteps')
    collectStepNameReferences(references, trafficPlan.setupSteps ?? trafficPlan.setup, 'execution.trafficPlan.setupSteps')
    collectStepNameReferences(references, trafficPlan.cleanupSteps ?? trafficPlan.cleanup, 'execution.trafficPlan.cleanupSteps')
    if (Array.isArray(trafficPlan.operations)) {
        trafficPlan.operations.forEach((operation, operationIndex) => {
            const operationRecord = asRecord(operation)
            collectStepNameReferences(
                references,
                operationRecord.steps ?? (operationRecord.step === undefined ? undefined : [operationRecord.step]),
                `execution.trafficPlan.operations[${operationIndex}].steps`,
            )
        })
    }
    steps.forEach((step, stepIndex) => {
        collectStepNameReferences(
            references,
            step.loopSteps ?? (Array.isArray(step.loop) ? step.loop : undefined),
            `steps[${stepIndex}].loopSteps`,
        )
        collectStepNameReferences(
            references,
            step.steps,
            `steps[${stepIndex}].steps`,
        )
    })

    return {
        defined,
        referenced: references,
        missing: references.filter(reference => !definedSet.has(reference.name)),
    }
}

function collectStepNameReferences(
    target: Array<{ name: string; path: string }>,
    value: unknown,
    path: string,
): void {
    if (!Array.isArray(value)) {
        return
    }

    value.forEach((entry, index) => {
        if (typeof entry === 'string') {
            target.push({
                name: entry,
                path: `${path}[${index}]`,
            })
        }
    })
}

function stepName(step: JsonRecord, index: number): string {
    return typeof step.name === 'string' && step.name.length > 0
        ? step.name
        : `step-${index + 1}`
}

function outputPreflight(
    rawConfig: JsonRecord,
    expandedConfig: JsonRecord,
    operations: readonly BlackBoxRunnerPreflightOperation[],
): BlackBoxRunnerPlanPreflight['outputs'] {
    const variableNames = new Set(Object.keys(asRecord(rawConfig.variables)))
    const produced = uniqueValues([
        ...producedOutputsFromSteps(Array.isArray(expandedConfig.steps) ? expandedConfig.steps.map(asRecord) : []),
        ...producedOutputsFromOperations(operations),
    ])
    const producedSet = new Set(produced)
    const consumed = uniqueValues([
        ...placeholderRoots(rawConfig),
        ...operations.flatMap(operation => placeholderRoots(operation)),
        ...transformConsumedRoots(rawConfig),
        ...operations.flatMap(operation => transformConsumedRoots(operation)),
    ].filter(root =>
        !variableNames.has(root) &&
        !RESERVED_PLACEHOLDER_ROOTS.has(root)
    ))

    return {
        produced,
        consumed: consumed.filter(root => producedSet.has(root)),
        missingConsumed: consumed.filter(root => !producedSet.has(root)),
    }
}

function producedOutputsFromSteps(steps: readonly JsonRecord[]): readonly string[] {
    return steps.flatMap(step => [
        stringValue(step.output),
        stringValue(asRecord(step.request).output),
        ...Object.keys(asRecord(step.outputs)),
        ...Object.keys(asRecord(asRecord(step.request).outputs)),
    ].filter((output): output is string => Boolean(output)))
}

function producedOutputsFromOperations(operations: readonly BlackBoxRunnerPreflightOperation[]): readonly string[] {
    return operations.flatMap(operation => [
        stringValue(asRecord(operation).output),
    ].filter((output): output is string => Boolean(output)))
}

function placeholderRoots(value: unknown): readonly string[] {
    const text = JSON.stringify(value)
    if (!text) {
        return []
    }

    return [...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_.-]*)}/g)]
        .map(match => match[1])
        .map(path => path.split('.')[0])
        .filter(root => root.length > 0)
}

function transformConsumedRoots(value: unknown): readonly string[] {
    if (Array.isArray(value)) {
        return value.flatMap(transformConsumedRoots)
    }

    if (!value || typeof value !== 'object') {
        return []
    }

    const record = asRecord(value)
    const roots: string[] = []
    if (isTransformOnlySpec(record)) {
        roots.push(...transformPathRoots(record.path, record.from, record.outputPath))
    }

    Object.values(record).forEach(nested => {
        roots.push(...transformConsumedRoots(nested))
    })

    return roots
}

function transformPathRoots(...values: readonly unknown[]): readonly string[] {
    return values
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .flatMap(value => {
            const segments = value.replaceAll(/\[(\d+)]/g, '.$1').split('.').filter(Boolean)
            if (segments[0] === 'outputs' || segments[0] === 'variables') {
                return segments[1] ? [segments[1]] : []
            }
            return []
        })
}

function isTransformOnlySpec(record: JsonRecord): boolean {
    const transformKeys = new Set([
        'path',
        'from',
        'outputPath',
        'template',
        'concat',
        'coalesce',
        'jsonStringify',
        'jsonParse',
        'urlEncode',
        'number',
        'string',
        'boolean',
        'uuid',
        'timestamp',
        'op',
        'operator',
        'type',
        'value',
        'input',
        'values',
        'format',
        'secret',
        'redact',
        'redactAs',
        'transform',
    ])
    const operatorKeys = [
        'path',
        'from',
        'outputPath',
        'template',
        'concat',
        'coalesce',
        'jsonStringify',
        'jsonParse',
        'urlEncode',
        'number',
        'string',
        'boolean',
        'uuid',
        'timestamp',
        'op',
        'operator',
    ]
    const keys = Object.keys(record)
    return keys.length > 0 &&
        operatorKeys.some(key => record[key] !== undefined) &&
        keys.every(key => transformKeys.has(key))
}

function redactionPreflight(rawConfig: JsonRecord): BlackBoxRunnerPlanPreflight['redactions'] {
    const secrets = toSecretNameSet(rawConfig.secretVariables ?? rawConfig.secrets)
    const variableSources = Object.entries(asRecord(rawConfig.variables))
        .flatMap(([name, value]) => {
            const record = asRecord(value)
            if (secrets.has(name) || record.secret === true || record.redact === true) {
                return [{
                    kind: 'variable' as const,
                    name,
                    redactAs: stringValue(record.redactAs),
                }]
            }
            return []
        })
    const outputSources = (Array.isArray(rawConfig.steps) ? rawConfig.steps.map(asRecord) : [])
        .flatMap((step, stepIndex) => outputRedactionSources(step, `steps[${stepIndex}]`))

    return {
        sources: [...variableSources, ...outputSources],
    }
}

function outputRedactionSources(step: JsonRecord, path: string): readonly Readonly<{ kind: 'output'; name: string; redactAs?: string }>[] {
    const sources: Array<Readonly<{ kind: 'output'; name: string; redactAs?: string }>> = []
    const request = asRecord(step.request)
    const directOutput = stringValue(step.output) ?? stringValue(request.output)
    if (
        directOutput &&
        (step.secret === true || step.redact === true || request.secret === true || request.redact === true)
    ) {
        sources.push({
            kind: 'output',
            name: directOutput,
            redactAs: stringValue(step.redactAs) ?? stringValue(request.redactAs) ?? `${path}.${directOutput}`,
        })
    }
    Object.entries({
        ...asRecord(step.outputs),
        ...asRecord(request.outputs),
    }).forEach(([name, spec]) => {
        const record = asRecord(spec)
        if (record.secret === true || record.redact === true) {
            sources.push({
                kind: 'output',
                name,
                redactAs: stringValue(record.redactAs) ?? `${path}.${name}`,
            })
        }
    })

    return sources
}

function providerModes(
    rawConfig: JsonRecord,
    operations: readonly BlackBoxRunnerPreflightOperation[],
): readonly string[] {
    const connectionModes = Object.values(asRecord(rawConfig.connections))
        .map(asRecord)
        .flatMap(connection => [
            stringValue(connection.provider),
            stringValue(connection.type),
        ])
    const operationModes = operations.flatMap(operation => [
        operation.provider,
        ['HTTP', 'MQ', 'WS', 'RTC', 'WEBRTC'].includes(operation.transport)
            ? operation.transport.toLowerCase()
            : undefined,
    ])

    return uniqueValues([
        ...connectionModes,
        ...operationModes,
    ].filter((mode): mode is string => Boolean(mode)))
}

function liveServiceRequirements(
    rawConfig: JsonRecord,
    operations: readonly BlackBoxRunnerPreflightOperation[],
    trafficPlanArtifact: JsonRecord | undefined,
): readonly string[] {
    const providers = new Set(providerModes(rawConfig, operations))
    const transports = new Set(operations.map(operation => operation.transport))
    const requirements: string[] = ['local black-box-runner process']

    if (transports.has('HTTP')) {
        requirements.push('reachable HTTP endpoints for HTTP steps')
    }
    if (transports.has('WS')) {
        requirements.push('reachable WebSocket endpoint and any required ticket/token for WS steps')
    }
    if (transports.has('RTC') || transports.has('WEBRTC')) {
        requirements.push('configured RTC provider for RTC steps')
    }
    if (providers.has('rallar') || providers.has('rallar-browser')) {
        requirements.push('live Rallar API/signaling environment for browser-backed Rallar RTC')
    }
    if (providers.has('rallar-remote-browser')) {
        requirements.push('Rallar black-box control server with connected browser agent')
    }
    if (providers.has('rallar-memory') || providers.has('rallar-stub')) {
        requirements.push('deterministic in-process RTC provider')
    }
    if (trafficPlanArtifact) {
        requirements.push('expanded traffic plan artifact for replay/debug')
    }

    return uniqueValues(requirements)
}

function trafficPlanPreflight(artifact: JsonRecord | undefined): BlackBoxRunnerPlanPreflight['trafficPlan'] {
    if (!artifact) {
        return undefined
    }

    return {
        enabled: true,
        replay: artifact.replay === true,
        seed: numberValue(artifact.seed),
        decisionCount: Array.isArray(artifact.decisions) ? artifact.decisions.length : 0,
        stepCount: Array.isArray(artifact.steps) ? artifact.steps.length : 0,
    }
}

function postRunAssertionCount(rawConfig: JsonRecord): number {
    const execution = asRecord(rawConfig.execution)
    return postRunAssertionSourceCount(rawConfig.postRunAssertions) +
        postRunAssertionSourceCount(execution.postRunAssertions) +
        postRunAssertionSourceCount(execution.thresholds)
}

function postRunAssertionSourceCount(value: unknown): number {
    if (Array.isArray(value)) {
        return value.length
    }

    const record = asRecord(value)
    if (Object.keys(record).length <= 0) {
        return 0
    }

    return isPostRunAssertionSpec(record)
        ? 1
        : Object.keys(record).length
}

function isPostRunAssertionSpec(record: JsonRecord): boolean {
    return record.path !== undefined ||
        record.metric !== undefined ||
        record.from !== undefined ||
        record.actual !== undefined ||
        record.operator !== undefined ||
        record.op !== undefined ||
        [
            'equals',
            'eq',
            'expected',
            'notEquals',
            'ne',
            'gte',
            'min',
            'atLeast',
            'lte',
            'max',
            'atMost',
            'gt',
            'lt',
            'between',
            'includes',
            'contains',
            'notIncludes',
            'exists',
        ].some(key => record[key] !== undefined)
}

function strictProfileIssues(
    rawConfig: JsonRecord,
    operations: readonly BlackBoxRunnerPreflightOperation[],
): readonly BlackBoxRunnerPreflightIssue[] {
    const issues: BlackBoxRunnerPreflightIssue[] = []
    const steps = Array.isArray(rawConfig.steps) ? rawConfig.steps.map(asRecord) : []

    steps.forEach((step, index) => {
        const type = String(step.type || '').toLowerCase()
        const request = asRecord(step.request)
        const expect = asRecord(step.expect || step.response)
        const path = `steps[${index}]`

        if (type.length > 0 && !isKnownStepType(type)) {
            issues.push({
                severity: 'error',
                code: 'STRICT_UNKNOWN_STEP_TYPE',
                message: `Unknown strict step type ${type}.`,
                path: `${path}.type`,
            })
        }

        if (type.startsWith('set') || type.startsWith('derive')) {
            if (typeof (step.output ?? request.output) !== 'string') {
                issues.push({
                    severity: 'error',
                    code: 'STRICT_SET_OUTPUT',
                    message: 'Strict set steps require output.',
                    path,
                })
            }
            if (
                step.value === undefined &&
                request.value === undefined &&
                step.transform === undefined &&
                request.transform === undefined &&
                step.derive === undefined &&
                request.derive === undefined
            ) {
                issues.push({
                    severity: 'error',
                    code: 'STRICT_SET_VALUE',
                    message: 'Strict set steps require value, request.value, transform, or request.transform.',
                    path,
                })
            }
        }

        if (type.startsWith('assert')) {
            const hasExpected = expect.body !== undefined ||
                expect.expect !== undefined ||
                expect.expected !== undefined ||
                Array.isArray(expect.anyOf)
            if (!hasExpected) {
                issues.push({
                    severity: 'error',
                    code: 'STRICT_ASSERT_EXPECTED',
                    message: 'Strict assert steps require expect.body, expect.expected, expect.expect, or expect.anyOf.',
                    path,
                })
            }
        }
    })

    operations
        .filter(operation => operation.transport === 'HTTP' && !operation.path)
        .forEach(operation => {
            issues.push({
                severity: 'error',
                code: 'STRICT_HTTP_TARGET',
                message: `Strict HTTP operation ${operation.name} requires request.path, request.url, or connection.url.`,
                path: operation.name,
            })
        })

    return issues
}

function isKnownStepType(type: string): boolean {
    return [
        'http',
        'http.request',
        'ws',
        'ws.open',
        'ws.send',
        'ws.wait',
        'ws.close',
        'rtc',
        'rtc.connect',
        'rtc.send',
        'rtc.wait',
        'rtc.close',
        'webrtc',
        'crdt',
        'crdt.open',
        'crdt.apply',
        'crdt.read',
        'crdt.sync',
        'crdt.health',
        'crdt.wait',
        'crdt.undo',
        'crdt.redo',
        'crdt.close',
        'crdt.destroy',
        'assert',
        'set',
        'derive',
        'parallel',
        'loop',
    ].some(known => type === known || type.startsWith(`${known}.`))
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
