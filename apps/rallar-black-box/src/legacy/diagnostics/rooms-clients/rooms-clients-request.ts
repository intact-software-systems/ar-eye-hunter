import type { AuthSession } from '@shared/api/api-config.ts';
import { RALLAR_SERVER_ENDPOINT_PRESETS } from '../../../rallar-server-workbench/rallar-server-endpoint-presets.ts';
import type {
    RallarServerEndpointPreset,
    RallarServerRestRequestInput,
    RallarServerWorkbenchVariables
} from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import { toRallarServerEndpointDraft } from '../../../rallar-server-workbench/to-rallar-server-endpoint-draft.ts';

function rallarServerPresetById(presetId: string): RallarServerEndpointPreset {
    const preset = RALLAR_SERVER_ENDPOINT_PRESETS.find(
        (entry) => entry.presetId === presetId
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
    }>
): RallarServerRestRequestInput {
    const draft = toRallarServerEndpointDraft(
        rallarServerPresetById(input.presetId),
        input.variables
    );
    const query = {
        ...(JSON.parse(draft.queryText || '{}') as Record<string, unknown>),
        ...(input.query ?? {})
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
        forbidPlaceholderBaseUrl: false
    };
}
