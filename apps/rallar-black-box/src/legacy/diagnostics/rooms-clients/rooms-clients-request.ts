import type { AuthSession } from '@shared/api/api-config.ts';
import {
    RALLAR_SERVER_ENDPOINT_PRESETS,
    applyRallarServerEndpointPreset,
    type RallarServerEndpointPreset,
    type RallarServerRestRequestInput,
    type RallarServerWorkbenchVariables,
} from '../../../rallar-server-workbench.ts';

function rallarServerPresetById(presetId: string): RallarServerEndpointPreset {
    const preset = RALLAR_SERVER_ENDPOINT_PRESETS.find(
        (entry) => entry.presetId === presetId,
    );
    if (!preset) {
        throw new Error(`Unknown Rallar Server preset: ${presetId}`);
    }
    return preset;
}

export function buildPresetRequestInput(
    input: Readonly<{
        presetId: string;
        variables: RallarServerWorkbenchVariables;
        apiBaseUrl: string;
        authSession?: AuthSession;
        timeoutMs: number;
        query?: Readonly<Record<string, unknown>>;
        attachAuth?: boolean;
    }>,
): RallarServerRestRequestInput {
    const draft = applyRallarServerEndpointPreset(
        rallarServerPresetById(input.presetId),
        input.variables,
    );
    const query = {
        ...(JSON.parse(draft.queryText || '{}') as Record<string, unknown>),
        ...(input.query ?? {}),
    };
    return {
        apiBaseUrl: input.apiBaseUrl,
        method: draft.method,
        path: draft.path,
        headersText: draft.headersText,
        queryText: JSON.stringify(query, null, 2),
        bodyText: draft.bodyText,
        responseBodyMode: draft.responseBodyMode,
        attachAuth: input.attachAuth ?? draft.attachAuth,
        authSession: input.authSession,
        timeoutMs: input.timeoutMs,
    };
}
