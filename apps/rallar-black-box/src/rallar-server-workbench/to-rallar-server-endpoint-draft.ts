import type {
    RallarServerEndpointDraft,
    RallarServerEndpointPreset,
    RallarServerWorkbenchVariables
} from './rallar-server-workbench-contracts.ts';

const TEMPLATE_VARIABLE = /\{([A-Za-z0-9_]+)\}/g;

export function toRallarServerEndpointDraft(
    preset: RallarServerEndpointPreset,
    variables: RallarServerWorkbenchVariables
): RallarServerEndpointDraft {
    return {
        method: preset.method,
        path: preset.pathTemplate.replace(
            TEMPLATE_VARIABLE,
            (placeholder, key: string) => encodeURIComponent(toVariableValue(variables, key) ?? placeholder)
        ),
        headersText: '{}',
        queryText: '{}',
        bodyText: preset.body === undefined
            ? ''
            : JSON.stringify(preset.body, null, 2).replace(
                TEMPLATE_VARIABLE,
                (placeholder, key: string) => toVariableValue(variables, key) ?? placeholder
            ),
        responseBodyMode: preset.responseBodyMode ?? 'auto',
        attachAuth: preset.requiresAuth
    };
}

function toVariableValue(variables: RallarServerWorkbenchVariables, key: string): string | undefined {
    return Object.hasOwn(variables, key) ? variables[key as keyof RallarServerWorkbenchVariables] : undefined;
}
