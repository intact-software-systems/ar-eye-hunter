import type { AuthSession } from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';
import { RALLAR_SERVER_ENDPOINT_PRESETS } from '../../../rallar-server-workbench/rallar-server-endpoint-presets.ts';
import type {
    RallarServerRestRequestInput,
    RallarServerWorkbenchVariables
} from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import { toRallarServerEndpointDraft } from '../../../rallar-server-workbench/to-rallar-server-endpoint-draft.ts';
import type { RoomsClientsAction } from './rooms-clients-contracts.ts';

export interface RoomsClientsPresetRequestSource {
    readonly action: RoomsClientsAction;
    readonly variables: RallarServerWorkbenchVariables;
    readonly apiBaseUrl: string;
    readonly authSession: AuthSession | undefined;
    readonly timeoutMs: number;
}

/** The action query is the whole request query, because endpoint presets carry none of their own. */
export function toRoomsClientsPresetRequestInput(
    { action, variables, apiBaseUrl, authSession, timeoutMs }: RoomsClientsPresetRequestSource
): Either<string, RallarServerRestRequestInput> {
    const preset = RALLAR_SERVER_ENDPOINT_PRESETS.find((entry) => entry.presetId === action.presetId);
    if (!preset) {
        return Either.ofLeft(`Unknown Rallar Server preset: ${action.presetId ?? action.actionId}`);
    }
    const draft = toRallarServerEndpointDraft(preset, variables);
    return Either.ofRight({
        ...draft,
        apiBaseUrl,
        queryText: JSON.stringify(action.query ?? {}, null, 2),
        authSession,
        timeoutMs,
        forbidPlaceholderBaseUrl: false
    });
}
