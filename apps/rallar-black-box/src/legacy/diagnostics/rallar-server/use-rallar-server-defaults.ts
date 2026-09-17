import type { RallarBlackBoxTestConfig } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { getRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/test-state-accessors.ts';
import { useMemo } from 'react';
import {
    createRallarServerRestCollectionTemplates
} from '../../../rallar-server-workbench/collections/create-rallar-server-rest-collection-templates.ts';
import { RALLAR_SERVER_ENDPOINT_PRESETS } from '../../../rallar-server-workbench/rallar-server-endpoint-presets.ts';
import type {
    RallarServerRestCollection,
    RallarServerWorkbenchVariables
} from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import { toRallarServerEndpointDraft } from '../../../rallar-server-workbench/to-rallar-server-endpoint-draft.ts';
import { toRallarServerWorkbenchVariables } from '../../../rallar-server-workbench/to-rallar-server-workbench-variables.ts';
import type {
    RallarServerRestCollectionDraft,
    RallarServerWorkbenchDraft
} from '../../../ui-cache/rallar-server-drafts.ts';
import type { UseRallarServerControllerInput } from './rallar-server-contracts.ts';

export interface RallarServerDefaults {
    /** Absent until a runtime configuration is loaded. */
    readonly config: RallarBlackBoxTestConfig | undefined;
    readonly variables: RallarServerWorkbenchVariables;
    readonly defaultDraft: RallarServerWorkbenchDraft;
    readonly collectionTemplates: readonly RallarServerRestCollection[];
    readonly defaultCollectionDraft: RallarServerRestCollectionDraft;
}

export function useRallarServerDefaults(input: UseRallarServerControllerInput): RallarServerDefaults {
    const config = getRallarBlackBoxCurrentConfig(input.state);
    const variables = useRallarServerVariables(input, config);
    const { apiBaseUrl } = input.globalValues;
    const defaultDraft = useMemo<RallarServerWorkbenchDraft>(() => ({
        ...toRallarServerEndpointDraft(RALLAR_SERVER_ENDPOINT_PRESETS[0], variables),
        apiBaseUrl,
        selectedPresetId: RALLAR_SERVER_ENDPOINT_PRESETS[0].presetId,
        timeoutMs: 5_000
    }), [apiBaseUrl, variables]);
    const collectionTemplates = useMemo(() => createRallarServerRestCollectionTemplates(variables), [variables]);
    const defaultCollectionDraft = useMemo<RallarServerRestCollectionDraft>(() => {
        const collection = collectionTemplates[0];
        return { selectedCollectionId: collection.collectionId, collection, variables: collection.variables ?? {} };
    }, [collectionTemplates]);
    return { config, variables, defaultDraft, collectionTemplates, defaultCollectionDraft };
}

function useRallarServerVariables(
    input: UseRallarServerControllerInput,
    config: RallarBlackBoxTestConfig | undefined
): RallarServerWorkbenchVariables {
    const { bootstrap, authSession, globalValues } = input;
    return useMemo(
        () =>
            toRallarServerWorkbenchVariables({
                hints: toRallarServerVariableHints(input, config),
                createOpaqueId: () => crypto.randomUUID()
            }),
        [
            authSession?.username,
            bootstrap.actor,
            config?.actor,
            globalValues.applicationId,
            globalValues.clientId,
            globalValues.roomId,
            globalValues.sessionId,
            globalValues.workspaceId
        ]
    );
}

function toRallarServerVariableHints(
    { bootstrap, authSession, globalValues }: UseRallarServerControllerInput,
    config: RallarBlackBoxTestConfig | undefined
): Partial<RallarServerWorkbenchVariables> {
    return {
        applicationId: globalValues.applicationId,
        workspaceId: globalValues.workspaceId,
        principalId: globalValues.clientId,
        sessionId: globalValues.sessionId,
        groupId: globalValues.roomId,
        username: authSession?.username ?? config?.actor ?? bootstrap.actor
    };
}
