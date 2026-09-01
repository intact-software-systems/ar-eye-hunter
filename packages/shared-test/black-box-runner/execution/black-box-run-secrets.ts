// deno-lint-ignore-file no-explicit-any
import {
    addRedaction,
    isRecord,
    type Redaction
} from './black-box-redaction.ts';

declare const process: { env: Record<string, string | undefined>; } | undefined;

export function defaultEnvironment(): Record<string, string | undefined> {
    return typeof process !== 'undefined'
        ? process.env
        : {};
}

function isEnvVariableDescriptor(value: any): value is Record<string, any> {
    return isRecord(value) &&
        (typeof value.env === 'string' || typeof value.fromEnv === 'string');
}

function toSecretNameSet(secretVariables: any): Set<string> {
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

export interface ResolveBlackBoxVariablesResult {
    variables: Record<string, any>;
    redactions: Redaction[];
}

export function resolveBlackBoxVariables(
    rawVariables: Record<string, any> = {},
    environment: Record<string, string | undefined> = defaultEnvironment(),
    secretVariables: any = []
): ResolveBlackBoxVariablesResult {
    const secrets = toSecretNameSet(secretVariables);
    const variables: Record<string, any> = {};
    const redactions: Redaction[] = [];

    Object.entries(rawVariables || {}).forEach(([key, value]) => {
        if (isEnvVariableDescriptor(value)) {
            const envName = String(value.env ?? value.fromEnv);
            const envValue = environment[envName];
            const hasEnvValue = envValue !== undefined && (envValue.length > 0 || value.allowEmpty === true);
            const fallbackValue = value.default !== undefined
                ? value.default
                : value.fallback;

            if (!hasEnvValue && fallbackValue === undefined && value.required === true) {
                throw new Error(`Missing required environment variable ${envName} for black-box variable ${key}`);
            }

            const resolvedValue = hasEnvValue
                ? envValue
                : fallbackValue;

            variables[key] = resolvedValue;

            if (value.secret === true || value.redact === true || secrets.has(key)) {
                addRedaction(redactions, String(value.redactAs || key), resolvedValue);
            }

            return;
        }

        variables[key] = value;

        if (secrets.has(key)) {
            addRedaction(redactions, key, value);
        }
    });

    return {
        variables,
        redactions
    };
}
