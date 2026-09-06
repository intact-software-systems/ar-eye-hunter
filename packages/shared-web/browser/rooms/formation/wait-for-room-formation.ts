import { normalizeWaitTimeoutMs } from '@shared-web/browser/connection/normalize-wait-timeout-ms.ts';
import { waitForSettledRead } from '@shared-web/browser/connection/wait-for-settled-read.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import { isGroupCausalRevisionAtOrAfter } from '@shared/api/group-client-views.ts';
import type { GroupActivationCondition } from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';

import type { GroupRef } from '../room-group-state-translation.ts';
import type {
    RallarRoomFormationStatus,
    RallarRoomFormationWaitResult,
    RallarRoomFormationWaitStatus,
    RallarRoomLayoutWaitOptions,
    RallarRoomLayoutWaitResult
} from './rallar-room-formation-contracts.ts';
import {
    readRoomFormationStatus,
    subscribeRoomFormation,
    subscribeRoomSnapshot,
    type ReadRoomFormationStatusInput
} from './room-formation-observation.ts';

export interface WaitForRoomFormationInput extends ReadRoomFormationStatusInput {
    readonly resolveOperationOptions: <T extends RallarOperationOptions>(options: T) => T & RallarOperationOptions;
}

export interface WaitForRoomStageInput extends WaitForRoomFormationInput {
    readonly stages: readonly GroupLifecycleState[];
    readonly options: RallarOperationOptions;
}

export interface WaitForRoomConditionInput extends WaitForRoomFormationInput {
    readonly conditions: readonly GroupActivationCondition[];
    readonly options: RallarOperationOptions;
}

export interface WaitForRoomLayoutInput extends WaitForRoomFormationInput {
    readonly options: RallarRoomLayoutWaitOptions;
}

interface WaitForRoomFormationResultInput<TResult extends RallarRoomFormationWaitResult>
    extends WaitForRoomFormationInput {
    readonly options: RallarOperationOptions;
    readonly subscribe: (
        input: ReadRoomFormationStatusInput,
        listener: () => void | Promise<void>
    ) => RallarUnsubscribe;
    readonly toResult: (formation: RallarRoomFormationStatus | undefined) => TResult;
}

export async function waitForRoomStage(input: WaitForRoomStageInput): Promise<RallarRoomFormationWaitResult> {
    return await waitForRoomFormationResult({
        ...input,
        subscribe: subscribeRoomSnapshot,
        toResult: (formation) =>
            toRoomFormationWaitResult(
                input.roomRef,
                formation,
                formation !== undefined && input.stages.includes(formation.stage)
            )
    });
}

export async function waitForRoomCondition(
    input: WaitForRoomConditionInput
): Promise<RallarRoomFormationWaitResult> {
    return await waitForRoomFormationResult({
        ...input,
        subscribe: subscribeRoomSnapshot,
        toResult: (formation) =>
            toRoomFormationWaitResult(
                input.roomRef,
                formation,
                formation?.condition !== undefined && input.conditions.includes(formation.condition)
            )
    });
}

export async function waitForRoomLayout(input: WaitForRoomLayoutInput): Promise<RallarRoomLayoutWaitResult> {
    const role = input.options.role ?? 'planned';
    const fence = input.options.after;
    return await waitForRoomFormationResult({
        ...input,
        subscribe: subscribeRoomFormation,
        toResult: (formation) => {
            const candidate = formation?.[role];
            const layout = candidate !== undefined &&
                    (fence === undefined ||
                        isGroupCausalRevisionAtOrAfter(candidate.overlay.sourceGroupStateCausalRevision, fence))
                ? candidate
                : undefined;
            return { ...toRoomFormationWaitResult(input.roomRef, formation, layout !== undefined), layout };
        }
    });
}

function toRoomFormationWaitResult(
    roomRef: GroupRef,
    formation: RallarRoomFormationStatus | undefined,
    reached: boolean
): RallarRoomFormationWaitResult {
    return { status: reached ? 'ready' : 'timeout', roomRef, formation };
}

/**
 * `ready` and `not-found` settle. A missing snapshot is `not-found` only for a
 * room this browser never held; an expired one keeps the wait going, and a
 * deadline or abort that finds a settled read reports that read.
 */
async function waitForRoomFormationResult<TResult extends RallarRoomFormationWaitResult>(
    input: WaitForRoomFormationResultInput<TResult>
): Promise<TResult> {
    const operationOptions = input.resolveOperationOptions(input.options);
    const readResult = (): TResult => {
        const formation = readRoomFormationStatus(input);
        const result = input.toResult(formation);
        if (formation !== undefined || input.stateStore.wasGroupSnapshotObserved(input.roomRef)) {
            return result;
        }
        return { ...result, status: 'not-found' };
    };
    const withStatus = (status: RallarRoomFormationWaitStatus): TResult => ({ ...readResult(), status });
    return await waitForSettledRead({
        readResult,
        isSettled: (result) => result.status === 'ready' || result.status === 'not-found',
        subscribe: (listener) => input.subscribe(input, listener),
        signal: operationOptions.signal,
        timeoutMs: normalizeWaitTimeoutMs(input.options.timeoutMs),
        toTimedOut: () => withStatus('timeout'),
        toAborted: () => withStatus('aborted')
    });
}
