import type { ApiJsonObject } from '../../../shared/api/api-json-value.ts';

import { toSecretNameSet } from './preflight-env-variables.ts';
import {
    toNonEmptyText,
    toPreflightJsonArray,
    toPreflightJsonObject
} from './preflight-json-values.ts';

export interface BlackBoxRunnerPreflightVariableRedaction {
    readonly kind: 'variable';
    readonly name: string;
    /** Absent when the variable names no replacement label, so its value is redacted under its own name. */
    readonly redactAs?: string;
}

export interface BlackBoxRunnerPreflightOutputRedaction {
    readonly kind: 'output';
    readonly name: string;
    readonly redactAs: string;
}

export type BlackBoxRunnerPreflightRedactionSource =
    | BlackBoxRunnerPreflightVariableRedaction
    | BlackBoxRunnerPreflightOutputRedaction;

export interface BlackBoxRunnerPreflightRedactions {
    readonly sources: readonly BlackBoxRunnerPreflightRedactionSource[];
}

/** Secret variables and secret step outputs are redacted; an output without a label is redacted under its step path. */
export function computeRedactionPreflight(rawConfig: ApiJsonObject): BlackBoxRunnerPreflightRedactions {
    const secrets = toSecretNameSet(rawConfig.secretVariables ?? rawConfig.secrets);
    const variableSources = Object.entries(toPreflightJsonObject(rawConfig.variables))
        .flatMap(([name, value]): readonly BlackBoxRunnerPreflightVariableRedaction[] => {
            const record = toPreflightJsonObject(value);
            return secrets.has(name) || record.secret === true || record.redact === true
                ? [{ kind: 'variable', name, redactAs: toNonEmptyText(record.redactAs) }]
                : [];
        });
    const outputSources = toPreflightJsonArray(rawConfig.steps)
        .map(toPreflightJsonObject)
        .flatMap((step, stepIndex) => toOutputRedactions(step, `steps[${stepIndex}]`));
    return {
        sources: [...variableSources, ...outputSources]
    };
}

function toOutputRedactions(step: ApiJsonObject, path: string): readonly BlackBoxRunnerPreflightOutputRedaction[] {
    const request = toPreflightJsonObject(step.request);
    const directOutput = toNonEmptyText(step.output) ?? toNonEmptyText(request.output);
    const directSecret = step.secret === true || step.redact === true || request.secret === true ||
        request.redact === true;
    const direct: readonly BlackBoxRunnerPreflightOutputRedaction[] = directOutput && directSecret
        ? [{
            kind: 'output',
            name: directOutput,
            redactAs: toNonEmptyText(step.redactAs) ?? toNonEmptyText(request.redactAs) ?? `${path}.${directOutput}`
        }]
        : [];
    const declared = Object.entries({
        ...toPreflightJsonObject(step.outputs),
        ...toPreflightJsonObject(request.outputs)
    }).flatMap(([name, spec]): readonly BlackBoxRunnerPreflightOutputRedaction[] => {
        const record = toPreflightJsonObject(spec);
        return record.secret === true || record.redact === true
            ? [{ kind: 'output', name, redactAs: toNonEmptyText(record.redactAs) ?? `${path}.${name}` }]
            : [];
    });
    return [...direct, ...declared];
}
