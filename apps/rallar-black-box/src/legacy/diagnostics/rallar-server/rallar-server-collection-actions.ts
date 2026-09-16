import type { RallarBlackBoxProviderMode } from '@shared-test/rallar-bb-test/client-defaults.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';
import type * as React from 'react';
import { computeRallarServerRestAssertions } from '../../../rallar-server-workbench/collections/compute-rallar-server-rest-assertions.ts';
import { toRallarServerCollectionStepRequestInput } from '../../../rallar-server-workbench/collections/to-rallar-server-collection-step-request-input.ts';
import { toRallarServerExtractedVariables } from '../../../rallar-server-workbench/collections/to-rallar-server-extracted-variables.ts';
import { toRallarServerRestCollectionRecipe } from '../../../rallar-server-workbench/collections/to-rallar-server-rest-collection-recipe.ts';
import type {
    RallarServerEndpointPreset,
    RallarServerRestCollection,
    RallarServerRestCollectionStep,
    RallarServerRestCollectionStepResult,
    RallarServerRestCollectionVariables,
    RallarServerRestRequestInput,
    RallarServerRestResponse
} from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import type { RallarServerWorkbenchDraft } from '../../../ui-persistence.ts';
import { json } from '../../shared/json-presentation.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import {
    decodeRallarServerCollectionDraftText,
    decodeRallarServerCollectionText
} from './decode-rallar-server-collection-text.ts';
import type { RallarServerCollectionOperations } from './rallar-server-contracts.ts';

export namespace RallarServerCollectionActions {
    export interface Input {
        readonly state: RallarBlackBoxTestState;
        /** Absent until the browser signs in; steps that attach auth then fail to build. */
        readonly authSession: AuthSession | undefined;
        readonly providerMode: RallarBlackBoxProviderMode;
        readonly draft: RallarServerWorkbenchDraft;
        readonly activePreset: RallarServerEndpointPreset;
        /** Absent until a request receives a response; an appended step then expects status 200. */
        readonly response: RallarServerRestResponse | undefined;
        readonly collectionTemplates: readonly RallarServerRestCollection[];
        readonly collectionText: string;
        readonly collectionVariablesText: string;
        readonly setSelectedCollectionId: React.Dispatch<React.SetStateAction<string>>;
        readonly setCollectionText: React.Dispatch<React.SetStateAction<string>>;
        readonly setCollectionVariablesText: React.Dispatch<React.SetStateAction<string>>;
        readonly setCollectionBusy: React.Dispatch<React.SetStateAction<boolean>>;
        readonly setCollectionError: React.Dispatch<React.SetStateAction<string | undefined>>;
        readonly setCollectionResults: React.Dispatch<
            React.SetStateAction<readonly RallarServerRestCollectionStepResult[]>
        >;
        sendRequest(request: RallarServerRestRequestInput): Promise<Either<string, RallarServerRestResponse>>;
    }
}

export class RallarServerCollectionActions implements RallarServerCollectionOperations {
    private readonly input: RallarServerCollectionActions.Input;

    constructor(input: RallarServerCollectionActions.Input) {
        this.input = input;
    }

    readonly applyCollectionTemplate = (collectionId: string): void => {
        const template = this.input.collectionTemplates.find((entry) => entry.collectionId === collectionId);
        if (!template) {
            return;
        }
        this.input.setSelectedCollectionId(template.collectionId);
        this.input.setCollectionText(json(template));
        this.input.setCollectionVariablesText(json(template.variables ?? {}));
        this.input.setCollectionResults([]);
        this.input.setCollectionError(undefined);
    };

    readonly addCurrentRequestToCollection = (): void => {
        decodeRallarServerCollectionText(this.input.collectionText)
            .flatMap(
                (error) => Either.ofLeft(error),
                (collection) =>
                    decodeCurrentRequestStep(this.input, collection.steps.length + 1).mapRight((step) => ({
                        ...collection,
                        steps: [...collection.steps, step]
                    }))
            )
            .fold(this.input.setCollectionError, (collection) => {
                this.input.setCollectionText(json(collection));
                this.input.setCollectionError(undefined);
            });
    };

    readonly runCollection = async (): Promise<void> => {
        this.input.setCollectionBusy(true);
        this.input.setCollectionError(undefined);
        this.input.setCollectionResults([]);
        try {
            await decodeRallarServerCollectionDraftText(this.input.collectionText, this.input.collectionVariablesText)
                .fold(
                    async (message) => this.input.setCollectionError(message),
                    ({ collection, variables }) =>
                        this.runCollectionSteps(collection, { ...(collection.variables ?? {}), ...variables })
                );
        }
        catch (error) {
            this.input.setCollectionError(error instanceof Error ? error.message : String(error));
        }
        finally {
            this.input.setCollectionBusy(false);
        }
    };

    readonly copyCollection = (): void => {
        const { state, authSession } = this.input;
        decodeRallarServerCollectionDraftText(this.input.collectionText, this.input.collectionVariablesText).fold(
            this.input.setCollectionError,
            ({ collection, variables }) => {
                void navigator.clipboard?.writeText(redactedJson({ ...collection, variables }, state, authSession));
            }
        );
    };

    readonly copyCollectionRecipe = (): void => {
        const { state, authSession, draft, providerMode } = this.input;
        decodeRallarServerCollectionDraftText(this.input.collectionText, this.input.collectionVariablesText)
            .flatMap(
                (error) => Either.ofLeft(error),
                ({ collection, variables }) =>
                    toRallarServerRestCollectionRecipe({
                        collection,
                        apiBaseUrl: draft.apiBaseUrl,
                        variables,
                        authSession,
                        defaultTimeoutMs: draft.timeoutMs,
                        forbidPlaceholderBaseUrl: providerMode === 'browser-rallar'
                    })
            )
            .fold(this.input.setCollectionError, (recipe) => {
                void navigator.clipboard?.writeText(redactedJson(recipe, state, authSession));
            });
    };

    private async runCollectionSteps(
        collection: RallarServerRestCollection,
        variables: RallarServerRestCollectionVariables
    ): Promise<void> {
        const { draft, authSession, providerMode } = this.input;
        let collectionVariables = variables;
        const results: RallarServerRestCollectionStepResult[] = [];
        for (const step of collection.steps) {
            const sent = await this.input.sendRequest(toRallarServerCollectionStepRequestInput({
                step,
                apiBaseUrl: draft.apiBaseUrl,
                variables: collectionVariables,
                authSession,
                defaultTimeoutMs: draft.timeoutMs,
                forbidPlaceholderBaseUrl: providerMode === 'browser-rallar'
            }));
            const result = sent.fold(
                (message) => {
                    this.input.setCollectionError(message);
                    return undefined;
                },
                (response) => toCollectionStepResult(step, response, collectionVariables)
            );
            if (!result) {
                return;
            }
            results.push(result);
            this.input.setCollectionResults([...results]);
            collectionVariables = { ...collectionVariables, ...result.extracted };
            this.input.setCollectionVariablesText(json(collectionVariables));
            if (!result.ok) {
                return;
            }
        }
    }
}

/** The step keeps the raw JSON parse message, which the operator sees as the collection error. */
function decodeCurrentRequestStep(
    { draft, activePreset, response }: RallarServerCollectionActions.Input,
    stepNumber: number
): Either<string, RallarServerRestCollectionStep> {
    try {
        const body = draft.bodyText.trim().length === 0 || draft.method === 'GET'
            ? undefined
            : JSON.parse(draft.bodyText);
        return Either.ofRight({
            stepId: `request-${stepNumber}`,
            label: activePreset.label,
            request: {
                method: draft.method,
                path: draft.path,
                headers: JSON.parse(draft.headersText || '{}'),
                query: JSON.parse(draft.queryText || '{}'),
                ...(body === undefined ? {} : { body }),
                responseBodyMode: draft.responseBodyMode,
                attachAuth: draft.attachAuth,
                timeoutMs: draft.timeoutMs
            },
            expect: { status: response?.status ?? 200 }
        });
    }
    catch (error) {
        return Either.ofLeft(error instanceof Error ? error.message : String(error));
    }
}

function toCollectionStepResult(
    step: RallarServerRestCollectionStep,
    response: RallarServerRestResponse,
    variables: RallarServerRestCollectionVariables
): RallarServerRestCollectionStepResult {
    const assertions = computeRallarServerRestAssertions({ response, expectation: step.expect, variables });
    return {
        stepId: step.stepId,
        label: step.label,
        ok: assertions.every((assertion) => assertion.ok),
        response,
        assertions,
        extracted: toRallarServerExtractedVariables(response, step.extract)
    };
}
