type JsonRecord = Record<string, unknown>

export function resolveBlackBoxRunnerLivePreflightVariableByEnv(
    config: JsonRecord,
    envName: string,
    environment: Record<string, string | undefined>,
): string | undefined {
    const direct = envValue(environment, envName)
    if (direct !== undefined) {
        return direct
    }

    for (const [variableName, value] of Object.entries(asRecord(config.variables))) {
        const descriptor = asRecord(value)
        if (descriptor.env === envName || descriptor.fromEnv === envName) {
            return resolveVariable(config, variableName, environment)
        }
    }

    return undefined
}

function resolveVariable(
    config: JsonRecord,
    variableName: string,
    environment: Record<string, string | undefined>,
    resolving = new Set<string>(),
): string | undefined {
    if (resolving.has(variableName)) {
        return undefined
    }

    const rawValue = asRecord(config.variables)[variableName]
    const descriptor = asRecord(rawValue)
    const descriptorEnv = stringValue(descriptor.env) ?? stringValue(descriptor.fromEnv)
    const environmentValue = descriptorEnv ? envValue(environment, descriptorEnv) : undefined
    if (environmentValue !== undefined) {
        return environmentValue
    }

    const fallbackValue = descriptorEnv
        ? descriptor.default ?? descriptor.fallback
        : rawValue
    const value = stringValue(fallbackValue)
    if (value === undefined) {
        return undefined
    }

    const nextResolving = new Set(resolving).add(variableName)
    return value.replace(/\{([^{}]+)\}/g, (placeholder, nestedVariableName: string) => {
        return resolveVariable(config, nestedVariableName, environment, nextResolving) ?? placeholder
    })
}

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : {}
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0
        ? value
        : undefined
}

function envValue(environment: Record<string, string | undefined>, name: string): string | undefined {
    const value = environment[name]
    return value && value.length > 0
        ? value
        : undefined
}
