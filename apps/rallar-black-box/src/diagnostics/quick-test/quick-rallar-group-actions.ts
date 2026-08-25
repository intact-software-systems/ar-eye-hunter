import { runDirectRallarGroupCreate, runDirectRallarGroupJoin } from '../../direct-rallar-operations.ts';
import { loadBrowserRallarFacade } from '../../legacy/rallar/load-browser-rallar-facade.ts';
import { recordValue as optionalRecord } from '../../legacy/shared/record-value.ts';
import { stringValue } from '../../legacy/shared/string-value.ts';
import type { DirectRallarOperationContext } from '../direct-rallar-contracts.ts';
import { runQuickRallarOperation } from './quick-rallar-operation-actions.ts';
import type { QuickRallarTestRuntimeState } from './use-quick-rallar-test-state.ts';

export interface QuickRallarGroupActionsInput {
    readonly operationContext: DirectRallarOperationContext;
    readonly activeTypeId: string;
    readonly activeTopicId: string;
    readonly activeContextId: string;
    readonly runtimeState: QuickRallarTestRuntimeState;
    updateGroupId(groupId: string): void;
}

export interface QuickRallarGroupActions {
    createGroup(): Promise<void>;
    joinGroup(): Promise<void>;
}

export function createQuickRallarGroupActions({
    operationContext,
    activeTypeId,
    activeTopicId,
    activeContextId,
    runtimeState,
    updateGroupId
}: QuickRallarGroupActionsInput): QuickRallarGroupActions {
    const operationInput = { operationContext, activeTypeId, activeTopicId, activeContextId, runtimeState };
    return {
        createGroup: () =>
            runQuickRallarOperation({
                ...operationInput,
                busyLabel: 'Create and join group',
                action: () => runDirectRallarGroupCreate(operationContext, loadBrowserRallarFacade),
                completedAction: 'Quick Test group created and joined',
                failedAction: 'Quick Test group create failed',
                onCompleted: (result) => {
                    const groupId = stringValue(optionalRecord(result.value).groupId);
                    if (groupId) {
                        updateGroupId(groupId);
                    }
                }
            }),
        joinGroup: () =>
            runQuickRallarOperation({
                ...operationInput,
                busyLabel: 'Join group',
                action: () => runDirectRallarGroupJoin(operationContext, loadBrowserRallarFacade),
                completedAction: 'Quick Test group joined',
                failedAction: 'Quick Test group join failed'
            })
    };
}
