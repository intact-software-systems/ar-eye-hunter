import type { RallarBlackBoxTestConfig } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { selectRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/selectors.ts';
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
import type { RallarServerRestCollectionDraft, RallarServerWorkbenchDraft } from '../../../ui-persistence.ts';
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
    const config = selectRallarBlackBoxCurrentConfig(input.state);
    const variables = useRallarServerVariables(input, config);
    const { bootstrap, globalValues } = input;
    const defaultDraft = useMemo<RallarServerWorkbenchDraft>(() => ({
        ...toRallarServerEndpointDraft(RALLAR_SERVER_ENDPOINT_PRESETS[0], variables),
        apiBaseUrl: globalValues?.apiBaseUrl ?? config?.apiBaseUrl ?? bootstrap.apiBaseUrl,
        selectedPresetId: RALLAR_SERVER_ENDPOINT_PRESETS[0].presetId,
        timeoutMs: 5_000
    }), [bootstrap.apiBaseUrl, config?.apiBaseUrl, globalValues?.apiBaseUrl, variables]);
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
            authSession?.clientId,
            authSession?.sessionId,
            authSession?.username,
            bootstrap.actor,
            bootstrap.roomId,
            bootstrap.sessionId,
            config?.actor,
            config?.roomId,
            config?.sessionId,
            globalValues?.applicationId,
            globalValues?.clientId,
            globalValues?.roomId,
            globalValues?.sessionId,
            globalValues?.workspaceId
        ]
    );
}

function toRallarServerVariableHints(
    { bootstrap, authSession, globalValues }: UseRallarServerControllerInput,
    config: RallarBlackBoxTestConfig | undefined
): Partial<RallarServerWorkbenchVariables> {
    return {
        applicationId: globalValues?.applicationId,
        workspaceId: globalValues?.workspaceId,
        principalId: globalValues?.clientId ?? authSession?.clientId ?? config?.actor ?? bootstrap.actor,
        sessionId: globalValues?.sessionId ?? authSession?.sessionId ?? config?.sessionId ?? bootstrap.sessionId,
        groupId: globalValues?.roomId ?? config?.roomId ?? bootstrap.roomId,
        username: authSession?.username ?? config?.actor ?? bootstrap.actor
    };
}
