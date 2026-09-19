import type {
    ApiJsonObject,
    ApiJsonValue
} from '../../../shared/api/api-json-value.ts';

import type { Redaction } from '../execution/black-box-redaction.ts';
import { toPreflightJsonObject } from './preflight-json-values.ts';

export type BlackBoxRunnerEnvironment = Readonly<Record<string, string | undefined>>;

export interface BlackBoxRunnerEnvRequirement {
    readonly variableName: string;
    readonly envName: string;
    readonly required: boolean;
    readonly secret: boolean;
    readonly hasValue: boolean;
    readonly hasDefault: boolean;
    readonly hasFallback: boolean;
    readonly source: 'env' | 'default' | 'fallback' | 'missing' | 'unset';
}

export interface BlackBoxRunnerPreflightVariables {
    readonly variables: ApiJsonObject;
    readonly redactions: Redaction[];
}

interface EnvVariableValue {
    readonly envName: string;
    /** Absent when the environment does not set the variable, or sets it empty without allowEmpty. */
    readonly envValue: string | undefined;
}

export function computeBlackBoxRunnerEnvRequirements(
    config: ApiJsonObject,
    environment: BlackBoxRunnerEnvironment
): readonly BlackBoxRunnerEnvRequirement[] {
    return Object.entries(toPreflightJsonObject(config.variables))
        .flatMap(([variableName, value]) => {
            if (!isEnvVariableDescriptor(value)) {
                return [];
            }
            const { envName, envValue } = readEnvVariableValue(value, environment);
            const hasValue = envValue !== undefined;
            const hasDefault = value.default !== undefined;
            const hasFallback = value.fallback !== undefined;
            const required = value.required === true;
            return [{
                variableName,
                envName,
                required,
                secret: value.secret === true || value.redact === true,
                hasValue,
                hasDefault,
                hasFallback,
                source: hasValue
                    ? 'env'
                    : hasDefault
                    ? 'default'
                    : hasFallback
                    ? 'fallback'
                    : required
                    ? 'missing'
                    : 'unset'
            }];
        });
}

/**
 * An environment variable without a value, default or fallback resolves to a `<missing:NAME>` marker, which is never
 * redacted.
 */
export function resolveBlackBoxRunnerVariablesForPreflight(
    rawVariables: ApiJsonObject,
    environment: BlackBoxRunnerEnvironment,
    secretVariables: ApiJsonValue | undefined
): BlackBoxRunnerPreflightVariables {
    const secrets = toSecretNameSet(secretVariables);
    const variables: Record<string, ApiJsonValue> = {};
    const redactions: Redaction[] = [];
    for (const [key, value] of Object.entries(rawVariables)) {
        if (!isEnvVariableDescriptor(value)) {
            variables[key] = value;
            if (secrets.has(key)) {
                appendRedaction(redactions, { name: key, value });
            }
            continue;
        }
        const { envName, envValue } = readEnvVariableValue(value, environment);
        const fallbackValue = value.default !== undefined ? value.default : value.fallback;
        const resolvedValue = envValue !== undefined
            ? envValue
            : fallbackValue !== undefined
            ? fallbackValue
            : `<missing:${envName}>`;
        variables[key] = resolvedValue;
        if (value.secret === true || value.redact === true || secrets.has(key)) {
            appendRedaction(redactions, { name: String(value.redactAs || key), value: resolvedValue });
        }
    }
    return { variables, redactions };
}

/** Secret variable names are a list, or one comma-separated text. */
export function toSecretNameSet(secretVariables: ApiJsonValue | undefined): ReadonlySet<string> {
    if (Array.isArray(secretVariables)) {
        return new Set(secretVariables.map(String));
    }
    if (typeof secretVariables === 'string') {
        return new Set(
            secretVariables
                .split(',')
                .map((value) => value.trim())
                .filter((value) => value.length > 0)
        );
    }
    return new Set();
}

function isEnvVariableDescriptor(value: ApiJsonValue): value is ApiJsonObject {
    const record = toPreflightJsonObject(value);
    return typeof record.env === 'string' || typeof record.fromEnv === 'string';
}

function readEnvVariableValue(descriptor: ApiJsonObject, environment: BlackBoxRunnerEnvironment): EnvVariableValue {
    const envName = String(descriptor.env ?? descriptor.fromEnv);
    const envValue = environment[envName];
    return {
        envName,
        envValue: envValue !== undefined && (envValue.length > 0 || descriptor.allowEmpty === true)
            ? envValue
            : undefined
    };
}

function appendRedaction(
    redactions: Redaction[],
    candidate: Readonly<{ name: string; value: ApiJsonValue; }>
): void {
    if (candidate.value === null) {
        return;
    }
    const text = String(candidate.value);
    if (text.length <= 0 || text.startsWith('<missing:')) {
        return;
    }
    if (!redactions.some((redaction) => redaction.name === candidate.name && redaction.value === text)) {
        redactions.push({ name: candidate.name, value: text });
    }
}
