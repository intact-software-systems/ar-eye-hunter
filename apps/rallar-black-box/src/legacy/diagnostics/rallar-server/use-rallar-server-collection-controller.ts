import type * as React from 'react';
import { useState } from 'react';
import type { RallarServerRestCollectionStepResult } from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import { sendRallarServerRestRequest } from '../../../rallar-server-workbench/send-rallar-server-rest-request.ts';
import { RallarServerCollectionActions } from './rallar-server-collection-actions.ts';
import type {
    RallarServerCollectionModel,
    RallarServerCollectionOperations,
    UseRallarServerControllerInput
} from './rallar-server-contracts.ts';
import { useRallarServerCollectionDraft } from './use-rallar-server-collection-draft.ts';
import type { RallarServerDefaults } from './use-rallar-server-defaults.ts';
import type { RallarServerRequestController } from './use-rallar-server-request-controller.ts';

export interface RallarServerCollectionController
    extends RallarServerCollectionModel, RallarServerCollectionOperations {}

interface RallarServerCollectionControls {
    readonly collectionBusy: boolean;
    readonly setCollectionBusy: React.Dispatch<React.SetStateAction<boolean>>;
    /** Absent when the last collection edit, run or copy succeeded. */
    readonly collectionError: string | undefined;
    readonly setCollectionError: React.Dispatch<React.SetStateAction<string | undefined>>;
    readonly collectionResults: readonly RallarServerRestCollectionStepResult[];
    readonly setCollectionResults: React.Dispatch<
        React.SetStateAction<readonly RallarServerRestCollectionStepResult[]>
    >;
}

/** Collection steps run against the request draft, so its base URL, timeout and last response apply. */
export function useRallarServerCollectionController(
    input: UseRallarServerControllerInput,
    defaults: RallarServerDefaults,
    request: RallarServerRequestController
): RallarServerCollectionController {
    const draft = useRallarServerCollectionDraft(defaults.defaultCollectionDraft, input.authSession);
    const controls = useRallarServerCollectionControls();
    const actions = new RallarServerCollectionActions({
        ...draft,
        ...controls,
        state: input.state,
        authSession: input.authSession,
        providerMode: request.providerMode,
        draft: request,
        activePreset: request.activePreset,
        response: request.response,
        collectionTemplates: defaults.collectionTemplates,
        sendRequest: (step) => sendRallarServerRestRequest({ request: step, fetch })
    });
    return {
        collectionTemplates: defaults.collectionTemplates,
        selectedCollectionId: draft.selectedCollectionId,
        collectionText: draft.collectionText,
        setCollectionText: draft.setCollectionText,
        collectionVariablesText: draft.collectionVariablesText,
        setCollectionVariablesText: draft.setCollectionVariablesText,
        collectionBusy: controls.collectionBusy,
        collectionError: controls.collectionError,
        collectionResults: controls.collectionResults,
        applyCollectionTemplate: actions.applyCollectionTemplate,
        addCurrentRequestToCollection: actions.addCurrentRequestToCollection,
        runCollection: actions.runCollection,
        copyCollection: actions.copyCollection,
        copyCollectionRecipe: actions.copyCollectionRecipe
    };
}

function useRallarServerCollectionControls(): RallarServerCollectionControls {
    const [collectionBusy, setCollectionBusy] = useState(false);
    const [collectionError, setCollectionError] = useState<string | undefined>();
    const [collectionResults, setCollectionResults] = useState<readonly RallarServerRestCollectionStepResult[]>([]);
    return {
        collectionBusy,
        setCollectionBusy,
        collectionError,
        setCollectionError,
        collectionResults,
        setCollectionResults
    };
}
