import utils from './utils.ts'
import {toRandomFromType} from './type-generators.ts'
import {toJsonMock, toSchemaType} from './json-mock-from-schema.ts'

type JsonRecord = Record<string, unknown>
type ReplaceMap = Record<string, string | number | boolean | undefined>

type GenerateConstant = {
    constant: string
    type: string
    min: string | number
    max: string | number
    numberOf?: number
    decimals?: number
    generated?: Array<string | number>
}

type ReplaceRule = {
    replace?: ReplaceMap
    generateForEach?: string[]
    generateAlways?: string[]
    generateConstants?: GenerateConstant[]
}

type ScenarioInput = JsonRecord & {
    interactions: Record<string, JsonRecord>
    numOfScenarios?: string | number
    generateForEach?: string[]
    generateAlways?: string[]
    replace?: ReplaceMap
    replaceRules?: Record<string, ReplaceRule>
    headerTemplateFile?: unknown
    headers?: unknown
}

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : {}
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map(String)
        : []
}

function toTechnology(technology: unknown): string {
    return String(technology || 'HTTP')
}

function replaceData(target: string | undefined, config: ReplaceMap): unknown {
    if (target === undefined) {
        return {}
    }

    let returnTarget = target
    Object.keys(config)
        .forEach(key => {
            returnTarget = returnTarget.replaceAll('{' + key + '}', String(config[key]))
        })

    return JSON.parse(returnTarget)
}

function toRuleRange(key: string, maxNumber: string | number): [number, number] {
    if (key.startsWith('>')) {
        return [Number.parseInt(key.replace('>', '')), Number.parseInt(String(maxNumber))]
    }

    if (key.includes('-')) {
        const numbers = key.split('-')
        if (Number.parseInt(numbers[0]) > Number.parseInt(numbers[1])) {
            throw 'Invalid number range: ' + key
        }

        return [Number.parseInt(numbers[0]), Number.parseInt(numbers[1])]
    }

    const number = Number.parseInt(key)
    if (number) {
        return [number, number]
    }

    return [0, 0]
}

function findReplaceRule(
    replaceRules: Record<string, ReplaceRule> | undefined,
    i: number,
    numOf: string | number,
): ReplaceRule {
    const entries = Object.entries(replaceRules || {})
    if (entries.length <= 0) {
        return {}
    }

    return entries
        .filter(([key]) => {
            const range = toRuleRange(key, numOf)
            return range[0] <= i && range[1] >= i
        })
        .map(([_key, value]) => value)[0] || {}
}

function replaceAlways(target: string | undefined, replace: ReplaceMap, generateAlways: string[]): unknown {
    if (!target) {
        return target
    }

    const config = {
        ...replace,
        ...utils.generateReplace(generateAlways, replace)
    } as ReplaceMap

    const keys = Object.keys(config)

    let returnTarget = target
    keys.forEach(key => {
        returnTarget = returnTarget.replaceAll(
            '{' + key + '}',
            () => {
                const newConfig = {
                    ...replace,
                    ...utils.generateReplace(generateAlways, replace)
                } as ReplaceMap

                return String(newConfig[key])
            }
        )
    })

    return JSON.parse(returnTarget)
}

function toInteraction(input: JsonRecord): JsonRecord {
    const requestTemplate = asRecord(input.requestTemplate)
    const responseTemplate = asRecord(input.responseTemplate)
    const replace = asRecord(input.replace) as ReplaceMap
    const generateAlways = asStringArray(input.generateAlways)

    const interaction: JsonRecord = {
        request: {
            interactionExecutionNumber: input.interactionExecutionNumber,
            scenarioExecutionNumber: input.scenarioExecutionNumber
        },
        response: {}
    }

    const request = asRecord(interaction.request)
    Object.keys(requestTemplate)
        .forEach(key => {
            request[key] = generateAlways.length > 0
                ? replaceAlways(JSON.stringify(requestTemplate[key]), replace, generateAlways)
                : replaceData(JSON.stringify(requestTemplate[key]), replace)
        })

    const response = asRecord(interaction.response)
    Object.keys(responseTemplate)
        .forEach(key => {
            response[key] = generateAlways.length > 0
                ? replaceAlways(JSON.stringify(responseTemplate[key]), replace, generateAlways)
                : replaceData(JSON.stringify(responseTemplate[key]), replace)
        })

    return {
        [String(input.technology)]: {
            ...interaction
        }
    }
}

function findGeneratedConstant(generateConstants: GenerateConstant[] | undefined, key: string, i: number): unknown {
    if (!generateConstants?.length) {
        return undefined
    }

    const constant = generateConstants.find(c => c.constant === key)
    if (!constant) {
        return undefined
    }

    if (!constant.generated || constant.generated.length < i + 1) {
        return undefined
    }

    return constant.generated[i]
}

function toArrayPosition(value: string): string {
    const start = value.indexOf('[')
    const end = value.indexOf(']')

    return value.substring(start + 1, end)
}

function toFilteredObject(replace: ReplaceMap | undefined, matcher: (value: string) => boolean): ReplaceMap {
    const entries = Object.entries(replace || {})
    if (entries.length <= 0) {
        return {}
    }

    const filtered = entries
        .filter(([_key, value]) => matcher(String(value)))
        .map(([key, value]) => {
            return {
                [key]: value
            }
        })

    return filtered.length === 0
        ? {}
        : filtered.reduce((a, b) => ({...a, ...b}))
}

function toReplaceEntriesToInject(replace: ReplaceMap | undefined): ReplaceMap {
    return toFilteredObject(
        replace,
        value => value.match('^[$][{].*.}$') !== null
    )
}

function toReplaceEntriesToNotInject(replace: ReplaceMap | undefined): ReplaceMap {
    return toFilteredObject(
        replace,
        value => value.match('^[$][{].*.}$') === null
    )
}

function toConstantName(value: string): string {
    const start = value.indexOf('{')
    const end = value.indexOf('[')

    return value.substring(start + 1, end)
}

function toInjectGeneratedValues(
    replace: ReplaceMap | undefined,
    generateConstants: GenerateConstant[] | undefined,
    i: number,
): ReplaceMap {
    const entries = Object.entries(replace || {})
    if (entries.length <= 0) {
        return {}
    }

    return entries
        .map(([key, value]) => {
            const valueAsString = String(value)
            const position = toArrayPosition(valueAsString)
            const constantName = toConstantName(valueAsString)

            const constant = findGeneratedConstant(
                generateConstants,
                constantName,
                position === 'N' || position === 'n' ? i : Number.parseInt(position),
            )
            if (constant === undefined) {
                return {}
            }
            return {
                [key]: constant
            }
        })
        .reduce((a, b) => ({...a, ...b}))
}

function toInteractions(input: JsonRecord, numOfInteractions = 1): Record<string, JsonRecord[]> {
    const interactions: JsonRecord[] = []

    for (let i = 1; i <= numOfInteractions; i++) {
        input.interactionExecutionNumber = i

        const replaceRule = findReplaceRule(
            input.interactionReplaceRules as Record<string, ReplaceRule> | undefined,
            i,
            numOfInteractions,
        )

        input.generateForEach = [
            ...asStringArray(input.generateForEach),
            ...asStringArray(replaceRule.generateForEach)
        ]

        input.generateAlways = [
            ...asStringArray(input.generateAlways),
            ...asStringArray(replaceRule.generateAlways)
        ]

        const replace = asRecord(input.replace) as ReplaceMap
        const generated = utils.generateReplace(asStringArray(input.generateForEach), replace)

        const resolvedReplace = toInjectGeneratedValues(
            toReplaceEntriesToInject(replaceRule.replace),
            (asRecord(input.scenarioReplaceRule).generateConstants as GenerateConstant[] | undefined),
            i
        )

        input.replace = {
            ...replace,
            ...generated,
            ...toReplaceEntriesToNotInject(replaceRule.replace),
            ...resolvedReplace
        }

        interactions.push(toInteraction(input))
    }

    return {
        [String(input.interactionName)]: interactions
    }
}

function toHeaders(headerFile: unknown, headers: unknown, defaultHeaders: unknown): unknown {
    if (headerFile) {
        return utils.openFile(String(headerFile))
    }

    return headers
        ? headers
        : defaultHeaders instanceof Object
            ? defaultHeaders
            : utils.openFile(String(defaultHeaders))
}

function resolveTemplate(data: JsonRecord | undefined): unknown {
    return data?.templateFile
        ? utils.openFile(String(data.templateFile))
        : data?.template
}

function resolveEntry(data: JsonRecord | undefined, template: unknown): unknown {
    return data?.entryName
        ? utils.resolvePathData(String(data.entryName), asRecord(template))
        : undefined
}

function resolveInputData(data: unknown): unknown {
    const record = asRecord(data)
    return resolveEntry(record, resolveTemplate(record)) || data
}

function toRequest(request: JsonRecord): JsonRecord {
    const {
        headerFile: _headerFile,
        ...outRequest
    } = request

    outRequest.body = request.body ? resolveInputData(request.body) : {}

    return outRequest
}

function toResponse(responseInput: unknown): JsonRecord {
    if (responseInput === undefined) {
        return {}
    }

    const response = asRecord(responseInput)
    const outResponse: JsonRecord = {...response}

    outResponse.body = response.body ? resolveInputData(response.body) : undefined

    if (!outResponse.body) {
        const schemaRecord = asRecord(response.schema)
        const template = resolveTemplate(schemaRecord)
        const schema = resolveEntry(schemaRecord, template)

        outResponse.body = toJsonMock(toSchemaType(template), schema, template)
    }

    return outResponse
}

function toInteractionTemplate(interaction: JsonRecord): JsonRecord {
    const interactionData = asRecord(resolveInputData(interaction))
    return asRecord(interactionData[toTechnology(interaction.technology)] || interactionData)
}

function toGenerateAlways(inputGenerateAlways: unknown, interactionGenerateAlways: unknown): string[] {
    return [
        ...asStringArray(inputGenerateAlways),
        ...asStringArray(interactionGenerateAlways)
    ]
}

function toScenario(
    input: ScenarioInput,
    globalReplace: ReplaceMap,
    replaceRule: ReplaceRule = {},
    scenarioExecutionNumber = 1,
): Array<Record<string, JsonRecord[]>> {
    replaceRule.generateConstants = toGenerateConstants(replaceRule.generateConstants || [])

    return Object.entries(input.interactions)
        .map(([interactionName, interaction]) => {
            const interactionTemplate = toInteractionTemplate(interaction)

            if (interactionTemplate === undefined || interactionTemplate.request === undefined) {
                console.log(interaction)
                throw new Error('Cannot find interaction template')
            }

            return toInteractions(
                {
                    interactionName,
                    scenarioExecutionNumber,
                    replace: {
                        ...globalReplace,
                        ...asRecord(interaction.replace) as ReplaceMap
                    },
                    interactionReplaceRules: interaction.replaceRules,
                    scenarioReplaceRule: replaceRule,
                    technology: toTechnology(interaction.technology),
                    generateForEach: asStringArray(interaction.generateForEach),
                    generateAlways: toGenerateAlways(input.generateAlways, interaction.generateAlways),
                    requestTemplate: {
                        ...toRequest(asRecord(interactionTemplate.request)),
                        headers: toHeaders(
                            asRecord(interactionTemplate.request).headerTemplateFile,
                            asRecord(interactionTemplate.request).headers,
                            asRecord(input.headerTemplateFile)?.[toTechnology(interaction.technology)] || input.headerTemplateFile || input.headers
                        )
                    },
                    responseTemplate: {
                        ...toResponse(interactionTemplate.response)
                    }
                },
                interaction.numOfInteractions ? Number.parseInt(String(interaction.numOfInteractions)) : 1
            )
        })
}

function toGenerateConstants(generateConstants: GenerateConstant[]): GenerateConstant[] {
    return generateConstants
        .map(constant => {
            return {
                ...constant,
                generated: toRandomFromType(
                    constant.type,
                    constant.min,
                    constant.max,
                    constant.numberOf || 1,
                    constant.decimals
                )
            }
        })
}

function createScenariosFromInput(input: ScenarioInput, numOfScenarios = 1): Array<Array<Record<string, JsonRecord[]>>> {
    const scenarios: Array<Array<Record<string, JsonRecord[]>>> = []
    for (let i = 1; i <= numOfScenarios; i++) {
        scenarios.push(
            toScenario(
                input,
                utils.toReplace(input.generateForEach, input.replace),
                findReplaceRule(input.replaceRules, i, numOfScenarios),
                i
            )
        )
    }

    return scenarios
}

function toInteractionsWithConfig(input: ScenarioInput, scenarios: Array<Array<Record<string, JsonRecord[]>>>): JsonRecord[] {
    return scenarios
        .map(scenario => {
            if (scenario.length <= 0) {
                return []
            }

            return scenario
                .map(interactionArray => {
                    return {
                        interactionArray
                    }
                })
        })
        .map(allInteractionsWithConfig => {
            return allInteractionsWithConfig
                .map(interactionsWithConfig => {
                    return Object.entries(interactionsWithConfig.interactionArray)
                        .map(([key, interactions]) => {
                            return interactions
                                .map(interaction => {
                                    return {
                                        ...interaction,
                                        dryRun: (input as any).dryRun === true ? true : (interaction as any).dryRun,
                                        [key]: input.interactions[key],
                                    }
                                })
                        })
                })
                .flatMap(a => a)
        })
        .flatMap(a => a)
}

export function createScenarios(input: ScenarioInput): JsonRecord[] {
    const scenarioJson = createScenariosFromInput(
        input,
        input.numOfScenarios ? Number.parseInt(String(input.numOfScenarios)) : 1
    )

    return toInteractionsWithConfig(input, scenarioJson)
}
