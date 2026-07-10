import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    DistributedRecipeCatalogItem,
    DistributedRecipeRolePattern,
    DistributedRecipeTargetPolicyMode,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import { useMemo, useState } from 'react';
import {
    distributedRecipeSchemaContextText,
    redactDistributedRecipePromptVariables,
    renderDistributedRecipePromptTemplate,
    renderDistributedRecipeValidationFeedback,
    type DistributedRecipePromptTemplateId,
} from '../../../../distributed-recipe-authoring-prompts.ts';
import { validateSchemaAuthoringText } from '../../../../schema-authoring.ts';
import type { CommandCenterGlobalValues } from '../../../shell/global-context-model.ts';
import { json } from '../../../shared/json-presentation.ts';
import { DistributedRecipeAuthoringPanel } from './DistributedRecipeAuthoringPanel.tsx';
import {
    distributedAuthoringDraftPreflights,
    distributedPromptFeedbackFromValidation,
    type DistributedAuthoringDraftTarget,
} from './distributed-recipe-authoring.ts';

type DistributedRecipeAuthoringSectionProps = Readonly<{
    manifest?: RallarBlackBoxDistributedRunManifest;
    globalValues: CommandCenterGlobalValues;
    baseUrl: string;
    token: string;
    selectedRunId: string;
    distributedRunId: string;
    targetPolicyMode: DistributedRecipeTargetPolicyMode;
    rolePattern: DistributedRecipeRolePattern;
    ackTimeoutMs: number;
    barrierEnabled: boolean;
    barrierTimeoutMs: number;
    startMode: RallarBlackBoxDistributedRunManifest['startMode'];
    selectedAgentIds: readonly string[];
    selectedRecipes: readonly DistributedRecipeCatalogItem[];
    onLastAction(message: string): void;
}>;

export function DistributedRecipeAuthoringSection(
    props: DistributedRecipeAuthoringSectionProps,
) {
    const {
        manifest,
        globalValues,
        baseUrl,
        token,
        selectedRunId,
        distributedRunId,
        targetPolicyMode,
        rolePattern,
        ackTimeoutMs,
        barrierEnabled,
        barrierTimeoutMs,
        startMode,
        selectedAgentIds,
        selectedRecipes,
        onLastAction,
    } = props;
    const [authoringTemplateId, setAuthoringTemplateId] =
        useState<DistributedRecipePromptTemplateId>('live-group-ack');
    const [authoringDraftTarget, setAuthoringDraftTarget] =
        useState<DistributedAuthoringDraftTarget>('distributed-run-manifest');
    const [authoringDraftText, setAuthoringDraftText] = useState('');
    const authoringSchemaContextText = useMemo(
        () => distributedRecipeSchemaContextText(),
        [],
    );
    const authoringDraftValidation = useMemo(
        () =>
            authoringDraftText.trim().length > 0
                ? validateSchemaAuthoringText(
                      authoringDraftTarget,
                      authoringDraftText,
                  )
                : undefined,
        [authoringDraftTarget, authoringDraftText],
    );
    const authoringDraftPreflights = useMemo(
        () => distributedAuthoringDraftPreflights(authoringDraftValidation),
        [authoringDraftValidation],
    );
    const authoringValidationFeedback = useMemo(
        () =>
            authoringDraftValidation
                ? distributedPromptFeedbackFromValidation(
                      authoringDraftValidation,
                      authoringDraftPreflights,
                  )
                : undefined,
        [authoringDraftPreflights, authoringDraftValidation],
    );
    const authoringValidationFeedbackText = useMemo(
        () =>
            authoringValidationFeedback
                ? renderDistributedRecipeValidationFeedback(
                      authoringValidationFeedback,
                  )
                : 'Paste generated JSON to get schema validation and distributed recipe preflight feedback.',
        [authoringValidationFeedback],
    );
    const authoringPromptVariables = useMemo(
        () => ({
            apiBaseUrl: globalValues.apiBaseUrl,
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            groupId: globalValues.roomId,
            clientId: globalValues.clientId,
            sessionId: globalValues.sessionId,
            controlHttpBaseUrl: baseUrl,
            controlRunId: selectedRunId,
            distributedRunId,
            targetPolicyMode,
            rolePattern,
            ackTimeoutMs,
            barrier: barrierEnabled
                ? { enabled: true, timeoutMs: barrierTimeoutMs }
                : undefined,
            startMode,
            selectedAgentIds,
            selectedRecipes: selectedRecipes.map((item) => ({
                itemId: item.itemId,
                recipeId: item.recipe.recipeId,
                title: item.title,
                live: item.live,
                profiles: item.profiles,
            })),
            controlToken: token,
        }),
        [
            ackTimeoutMs,
            barrierEnabled,
            barrierTimeoutMs,
            baseUrl,
            distributedRunId,
            globalValues.apiBaseUrl,
            globalValues.applicationId,
            globalValues.clientId,
            globalValues.roomId,
            globalValues.sessionId,
            globalValues.workspaceId,
            rolePattern,
            selectedAgentIds,
            selectedRecipes,
            selectedRunId,
            startMode,
            targetPolicyMode,
            token,
        ],
    );
    const redactedAuthoringPromptVariables = useMemo(
        () => redactDistributedRecipePromptVariables(authoringPromptVariables),
        [authoringPromptVariables],
    );
    const authoringPromptText = useMemo(
        () =>
            renderDistributedRecipePromptTemplate(authoringTemplateId, {
                variables: authoringPromptVariables,
                validationFeedback: authoringValidationFeedback,
            }),
        [
            authoringPromptVariables,
            authoringTemplateId,
            authoringValidationFeedback,
        ],
    );

    const copyAuthoringText = async (
        text: string,
        label: string,
    ): Promise<void> => {
        if (!navigator.clipboard) {
            onLastAction('Clipboard is unavailable in this browser context.');
            return;
        }
        await navigator.clipboard.writeText(text);
        onLastAction(label);
    };

    const useManifestPreviewForAuthoring = (): void => {
        if (!manifest) {
            return;
        }
        setAuthoringDraftTarget('distributed-run-manifest');
        setAuthoringDraftText(json(manifest));
        onLastAction('Loaded manifest preview into Generate With AI draft.');
    };

    return (
        <DistributedRecipeAuthoringPanel
            selectedTemplateId={authoringTemplateId}
            promptText={authoringPromptText}
            schemaContextText={authoringSchemaContextText}
            promptVariables={redactedAuthoringPromptVariables}
            draftTarget={authoringDraftTarget}
            draftText={authoringDraftText}
            draftValidation={authoringDraftValidation}
            draftPreflights={authoringDraftPreflights}
            validationFeedbackText={authoringValidationFeedbackText}
            canUseManifestPreview={Boolean(manifest)}
            onTemplateChange={setAuthoringTemplateId}
            onDraftTargetChange={setAuthoringDraftTarget}
            onDraftTextChange={setAuthoringDraftText}
            onCopyPrompt={() =>
                void copyAuthoringText(
                    authoringPromptText,
                    'Copied distributed recipe prompt.',
                )
            }
            onCopySchemaContext={() =>
                void copyAuthoringText(
                    authoringSchemaContextText,
                    'Copied distributed recipe schema context.',
                )
            }
            onCopyValidationFeedback={() =>
                void copyAuthoringText(
                    authoringValidationFeedbackText,
                    'Copied distributed recipe validation feedback.',
                )
            }
            onUseManifestPreview={useManifestPreviewForAuthoring}
        />
    );
}
