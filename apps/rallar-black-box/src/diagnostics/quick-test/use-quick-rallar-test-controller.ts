import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { useMemo } from 'react';
import type { CommandCenterGlobalValues } from '../../legacy/shell/global-context-model.ts';
import type { RallarBrowserStatusSummary } from '../../legacy/shell/rallar-browser-status.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../runtime-store.ts';
import type { DirectRallarOperationContext } from '../direct-rallar-contracts.ts';
import type {
    QuickRallarPayloadResult,
    QuickRallarTestViewModel,
    QuickRallarValues
} from './quick-rallar-contracts.ts';
import { computeQuickRallarWorkflowSteps } from './quick-rallar-workflow.ts';
import { useQuickRallarTestActions } from './use-quick-rallar-test-actions.ts';
import { useQuickRallarTestRuntimeState, useQuickRallarTestValues } from './use-quick-rallar-test-state.ts';

export interface UseQuickRallarTestControllerInput {
    readonly state: RallarBlackBoxTestState;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly authSession?: AuthSession;
    readonly globalValues: CommandCenterGlobalValues;
    readonly browserStatus: RallarBrowserStatusSummary;
    onGlobalValueChange<K extends keyof CommandCenterGlobalValues>(key: K, value: CommandCenterGlobalValues[K]): void;
}

export function useQuickRallarTestController(
    input: UseQuickRallarTestControllerInput
): QuickRallarTestViewModel {
    const valuesState = useQuickRallarTestValues({
        groupId: input.globalValues.roomId,
        onGroupIdChange: (groupId) => input.onGlobalValueChange('roomId', groupId)
    });
    const runtimeState = useQuickRallarTestRuntimeState();
    const scope = useQuickRallarTestScope(input, valuesState.values);
    const payloadResult = useQuickRallarPayload(valuesState.values.payloadText);
    const actions = useQuickRallarTestActions({
        state: input.state,
        authSession: input.authSession,
        values: valuesState.values,
        browserStatus: input.browserStatus,
        payloadResult,
        ...scope,
        runtimeState,
        updateGroupId: valuesState.updateGroupId
    });
    const workflowSteps = computeQuickRallarWorkflowSteps({
        realBackendReady: scope.realBackendReady,
        authSession: input.authSession,
        activeGroupId: scope.activeGroupId,
        activeTypeId: scope.activeTypeId,
        activeTopicId: scope.activeTopicId,
        subscription: runtimeState.subscription,
        payloadResult,
        lastResult: runtimeState.lastResult,
        receivedMessageCount: runtimeState.receivedMessages.length,
        waitStatus: runtimeState.waitStatus
    });

    return {
        values: valuesState.values,
        busyAction: runtimeState.busyAction,
        localError: runtimeState.localError,
        lastResult: runtimeState.lastResult,
        subscription: runtimeState.subscription,
        receivedMessages: runtimeState.receivedMessages,
        waitStatus: runtimeState.waitStatus,
        providerMode: input.bootstrap.providerMode,
        realBackendReady: scope.realBackendReady,
        canUseDirectRallar: scope.realBackendReady && Boolean(input.authSession) && !runtimeState.busyAction,
        activeGroupId: scope.activeGroupId,
        activeTypeId: scope.activeTypeId,
        activeContextId: scope.activeContextId,
        selectorLabel: scope.selectorLabel,
        payloadResult,
        updateValue: valuesState.updateValue,
        updateGroupId: valuesState.updateGroupId,
        ...actions,
        setupComplete: scope.realBackendReady && Boolean(input.authSession) && Boolean(scope.activeGroupId),
        subscribed: Boolean(runtimeState.subscription),
        workflowSteps
    };
}

interface QuickRallarTestScope {
    readonly realBackendReady: boolean;
    readonly activeGroupId: string;
    readonly activeTypeId: string;
    readonly activeTopicId: string;
    readonly activeContextId: string;
    readonly selectorLabel: string;
    readonly operationContext: DirectRallarOperationContext;
}

interface QuickRallarScopeValues extends Pick<QuickRallarValues, 'typeId' | 'topicId' | 'contextId' | 'timeoutMs'> {}

function useQuickRallarTestScope(
    input: UseQuickRallarTestControllerInput,
    values: QuickRallarScopeValues
): QuickRallarTestScope {
    const activeGroupId = input.globalValues.roomId.trim();
    const activeTypeId = values.typeId.trim();
    const activeTopicId = values.topicId.trim() || activeTypeId;
    const activeContextId = values.contextId.trim() || activeGroupId || 'room';
    return {
        realBackendReady: input.bootstrap.providerMode === 'browser-rallar',
        activeGroupId,
        activeTypeId,
        activeTopicId,
        activeContextId,
        selectorLabel: `${activeTopicId || '*'} / ${activeTypeId || '-'}`,
        operationContext: {
            providerMode: input.bootstrap.providerMode,
            apiBaseUrl: input.globalValues.apiBaseUrl,
            applicationId: input.globalValues.applicationId,
            workspaceId: input.globalValues.workspaceId,
            roomId: activeGroupId,
            actor: input.authSession?.username ?? input.authSession?.clientId ?? input.bootstrap.actor,
            connection: 'quick-test',
            authSession: input.authSession,
            timeoutMs: values.timeoutMs
        }
    };
}

function useQuickRallarPayload(payloadText: string): QuickRallarPayloadResult {
    return useMemo(() => {
        try {
            return { ok: true, value: JSON.parse(payloadText) };
        }
        catch (error) {
            return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
        }
    }, [payloadText]);
}
