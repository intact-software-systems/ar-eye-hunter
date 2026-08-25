import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { redactedJson } from '../../legacy/shared/redaction-presentation.ts';
import type { RallarBrowserStatusSummary } from '../../legacy/shell/rallar-browser-status.ts';
import type { DirectRallarOperationContext } from '../direct-rallar-contracts.ts';
import type { QuickRallarPayloadResult, QuickRallarValues } from './quick-rallar-contracts.ts';
import type { QuickRallarTestRuntimeState } from './use-quick-rallar-test-state.ts';

export interface QuickRallarDiagnosticsActionsInput {
    readonly state: RallarBlackBoxTestState;
    readonly authSession?: AuthSession;
    readonly operationContext: DirectRallarOperationContext;
    readonly values: QuickRallarValues;
    readonly activeTypeId: string;
    readonly activeTopicId: string;
    readonly activeContextId: string;
    readonly payloadResult: QuickRallarPayloadResult;
    readonly browserStatus: RallarBrowserStatusSummary;
    readonly runtimeState: QuickRallarTestRuntimeState;
}

export interface QuickRallarDiagnosticsActions {
    copyDiagnostics(): void;
    copyRunnerRecipe(): void;
}

export function createQuickRallarDiagnosticsActions(
    input: QuickRallarDiagnosticsActionsInput
): QuickRallarDiagnosticsActions {
    return {
        copyDiagnostics: () => copyQuickRallarDiagnostics(input),
        copyRunnerRecipe: () => copyQuickRallarRunnerRecipe(input)
    };
}

function copyQuickRallarDiagnostics({
    state,
    authSession,
    operationContext,
    values,
    activeTypeId,
    activeTopicId,
    activeContextId,
    browserStatus,
    runtimeState
}: QuickRallarDiagnosticsActionsInput): void {
    void navigator.clipboard?.writeText(redactedJson(
        {
            providerMode: operationContext.providerMode,
            context: {
                apiBaseUrl: operationContext.apiBaseUrl,
                applicationId: operationContext.applicationId,
                workspaceId: operationContext.workspaceId,
                groupId: operationContext.roomId,
                actor: operationContext.actor,
                sessionId: authSession?.sessionId
            },
            values,
            selector: { typeId: activeTypeId, topicId: activeTopicId, contextId: activeContextId },
            browserStatus,
            subscription: runtimeState.subscription,
            waitStatus: runtimeState.waitStatus,
            localError: runtimeState.localError,
            lastResult: runtimeState.lastResult,
            receivedMessages: runtimeState.receivedMessages.slice(-8)
        },
        state,
        authSession
    ));
}

function copyQuickRallarRunnerRecipe({
    state,
    authSession,
    operationContext,
    activeTypeId,
    activeTopicId,
    activeContextId,
    payloadResult,
    values
}: QuickRallarDiagnosticsActionsInput): void {
    void navigator.clipboard?.writeText(redactedJson(
        quickRallarRunnerRecipe({
            authSession,
            operationContext,
            activeTypeId,
            activeTopicId,
            activeContextId,
            payloadResult,
            values
        }),
        state,
        authSession
    ));
}

interface QuickRallarRunnerRecipeInput extends
    Pick<
        QuickRallarDiagnosticsActionsInput,
        | 'authSession'
        | 'operationContext'
        | 'activeTypeId'
        | 'activeTopicId'
        | 'activeContextId'
        | 'payloadResult'
        | 'values'
    > {}

interface QuickRallarRunnerRecipe {
    readonly recipeId: string;
    readonly name: string;
    readonly requirements: readonly string[];
    readonly continueOnFailure: boolean;
    readonly commands: readonly object[];
}

const QUICK_RALLAR_RUNNER_REQUIREMENTS = [
    'provider=browser-rallar',
    'logged-in browser session',
    'Rallar Server API reachable',
    'receiver browser subscribed to same group/type/topic'
] as const;

function quickRallarRunnerRecipe({
    authSession,
    operationContext,
    activeTypeId,
    activeTopicId,
    activeContextId,
    payloadResult,
    values
}: QuickRallarRunnerRecipeInput): QuickRallarRunnerRecipe {
    return {
        recipeId: 'rallar-quick-test-ws-group',
        name: 'Rallar Quick Test WS group send',
        requirements: QUICK_RALLAR_RUNNER_REQUIREMENTS,
        continueOnFailure: false,
        commands: [
            {
                kind: 'configure',
                commandId: 'quick-configure',
                config: {
                    runId: 'rallar-quick-test-export',
                    apiBaseUrl: operationContext.apiBaseUrl,
                    actor: authSession?.username ?? operationContext.actor,
                    sessionId: authSession?.sessionId,
                    roomId: operationContext.roomId,
                    providerMode: operationContext.providerMode,
                    rallar: {
                        restoreSession: true,
                        applicationId: operationContext.applicationId,
                        workspaceId: operationContext.workspaceId,
                        roomRef: {
                            applicationId: operationContext.applicationId,
                            workspaceId: operationContext.workspaceId,
                            groupId: operationContext.roomId
                        },
                        typeId: activeTypeId,
                        topicId: activeTopicId
                    }
                }
            },
            {
                kind: 'ws.send',
                commandId: 'quick-ws-send',
                connection: 'quick-test',
                data: {
                    scope: 'room',
                    roomId: operationContext.roomId,
                    typeId: activeTypeId,
                    topicId: activeTopicId,
                    contextId: activeContextId,
                    payload: payloadResult.ok ? payloadResult.value ?? {} : {}
                },
                timeoutMs: values.timeoutMs
            }
        ]
    };
}
