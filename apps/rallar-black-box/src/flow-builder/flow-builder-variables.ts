import type { FlowBuilderDefinition } from './flow-builder-contracts.ts';

const FLOW_VARIABLE_EXACT_REFERENCE = /^(?:\{\{([^{}]+)\}\}|\$\{([^{}]+)\}|\{([A-Za-z0-9_.-]+)\})$/;
const FLOW_VARIABLE_REFERENCES: readonly RegExp[] = [/\{\{([^{}]+)\}\}/g, /\$\{([^{}]+)\}/g, /\{([A-Za-z0-9_.-]+)\}/g];

export function toSubstitutedFlowBuilderValue(
    value: unknown,
    variables: Readonly<Record<string, unknown>>
): unknown {
    if (typeof value === 'string') {
        return toSubstitutedString(value, variables);
    }

    if (Array.isArray(value)) {
        return value.map((entry) => toSubstitutedFlowBuilderValue(entry, variables));
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [
                key,
                toSubstitutedFlowBuilderValue(entry, variables)
            ])
        );
    }

    return value;
}

export function computeFlowBuilderVariables(
    flow: FlowBuilderDefinition,
    overrides: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
    const variables: Record<string, unknown> = {
        ...flow.variables,
        ...overrides
    };

    for (const step of flow.steps) {
        if (step.enabled === false || step.kind !== 'set') {
            continue;
        }

        Object.assign(variables, toSubstitutedFlowBuilderValue(step.set ?? {}, variables));
    }

    return variables;
}

function toSubstitutedString(value: string, variables: Readonly<Record<string, unknown>>): unknown {
    const exact = value.match(FLOW_VARIABLE_EXACT_REFERENCE);
    if (exact) {
        const variable = toVariableValue(variables, exact[1] ?? exact[2] ?? exact[3]);
        return variable === undefined ? value : variable;
    }

    return FLOW_VARIABLE_REFERENCES.reduce(
        (text, reference) =>
            text.replace(reference, (match, variableName: string) => {
                const variable = toVariableValue(variables, variableName);
                return variable === undefined ? match : String(variable);
            }),
        value
    );
}

function toVariableValue(variables: Readonly<Record<string, unknown>>, path: string): unknown {
    let current: unknown = variables;
    for (const part of path.split('.')) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            return undefined;
        }
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}
