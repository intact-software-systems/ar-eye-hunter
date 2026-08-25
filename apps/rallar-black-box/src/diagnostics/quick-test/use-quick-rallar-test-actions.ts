import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBrowserStatusSummary } from '../../legacy/shell/rallar-browser-status.ts';
import type { DirectRallarOperationContext } from '../direct-rallar-contracts.ts';
import type { QuickRallarPayloadResult, QuickRallarValues } from './quick-rallar-contracts.ts';
import { createQuickRallarDiagnosticsActions } from './quick-rallar-diagnostics-actions.ts';
import { createQuickRallarGroupActions } from './quick-rallar-group-actions.ts';
import { createQuickRallarMessageActions } from './quick-rallar-message-actions.ts';
import { waitForQuickRallarReceive } from './quick-rallar-receive-wait.ts';
import type { QuickRallarTestRuntimeState } from './use-quick-rallar-test-state.ts';

export interface UseQuickRallarTestActionsInput {
    readonly state: RallarBlackBoxTestState;
    readonly authSession?: AuthSession;
    readonly browserStatus: RallarBrowserStatusSummary;
    readonly values: QuickRallarValues;
    readonly payloadResult: QuickRallarPayloadResult;
    readonly operationContext: DirectRallarOperationContext;
    readonly activeTypeId: string;
    readonly activeTopicId: string;
    readonly activeContextId: string;
    readonly selectorLabel: string;
    readonly runtimeState: QuickRallarTestRuntimeState;
    updateGroupId(groupId: string): void;
}

export function useQuickRallarTestActions(input: UseQuickRallarTestActionsInput) {
    const actionContext = {
        operationContext: input.operationContext,
        activeTypeId: input.activeTypeId,
        activeTopicId: input.activeTopicId,
        activeContextId: input.activeContextId,
        runtimeState: input.runtimeState
    };
    return {
        ...createQuickRallarGroupActions({ ...actionContext, updateGroupId: input.updateGroupId }),
        ...createQuickRallarMessageActions({
            ...actionContext,
            activeResourceId: input.values.resourceId.trim() || undefined,
            selectorLabel: input.selectorLabel,
            payloadResult: input.payloadResult
        }),
        waitForReceive: () =>
            waitForQuickRallarReceive({
                operationContext: input.operationContext,
                timeoutMs: input.values.timeoutMs,
                runtimeState: input.runtimeState
            }),
        ...createQuickRallarDiagnosticsActions(input)
    };
}
