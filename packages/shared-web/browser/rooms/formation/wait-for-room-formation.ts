import { normalizeWaitTimeoutMs } from '@shared-web/browser/connection/normalize-wait-timeout-ms.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type { GroupActivationCondition } from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';

import type { GroupStateCausalRevision } from '../room-group-state-translation.ts';
import { waitForRoomChange } from '../wait-for-room-change.ts';
import type {
    RallarRoomFormationStatus,
    RallarRoomFormationWaitResult,
    RallarRoomFormationWaitStatus,
    RallarRoomLayout,
    RallarRoomLayoutWaitOptions,
    RallarRoomLayoutWaitResult
} from './rallar-room-formation-contracts.ts';
import {
    readRoomFormationStatus,
    subscribeRoomFormation,
    type ReadRoomFormationStatusInput
} from './room-formation-observation.ts';

export interface WaitForRoomFormationInput extends ReadRoomFormationStatusInput {
    readonly resolveOperationOptions: <T extends RallarOperationOptions>(options: T) => T & RallarOperationOptions;
}

export interface WaitForRoomStageInput extends WaitForRoomFormationInput {
    readonly stages: readonly GroupLifecycleState[];
    readonly options: RallarScopedOperationOptions;
}

export interface WaitForRoomConditionInput extends WaitForRoomFormationInput {
    readonly conditions: readonly GroupActivationCondition[];
    readonly options: RallarScopedOperationOptions;
}

export interface WaitForRoomLayoutInput extends WaitForRoomFormationInput {
    readonly options: RallarRoomLayoutWaitOptions;
}

interface WaitForRoomFormationStatusInput extends WaitForRoomFormationInput {
    readonly options: RallarScopedOperationOptions;
    readonly isReached: (formation: RallarRoomFormationStatus) => boolean;
}

export async function waitForRoomStage(input: WaitForRoomStageInput): Promise<RallarRoomFormationWaitResult> {
    return await waitForRoomFormationStatus({
        ...input,
        isReached: (formation) => input.stages.includes(formation.stage)
    });
}

export async function waitForRoomCondition(
    input: WaitForRoomConditionInput
): Promise<RallarRoomFormationWaitResult> {
    return await waitForRoomFormationStatus({
        ...input,
        isReached: (formation) => formation.condition !== undefined && input.conditions.includes(formation.condition)
    });
}

async function waitForRoomFormationStatus(
    input: WaitForRoomFormationStatusInput
): Promise<RallarRoomFormationWaitResult> {
    const operationOptions = input.resolveOperationOptions(input.options);
    const readResult = (override?: RallarRoomFormationWaitStatus): RallarRoomFormationWaitResult => {
        const formation = readRoomFormationStatus(input);
        const status = formation === undefined ? 'not-found' : input.isReached(formation) ? 'ready' : 'timeout';
        return { status: override ?? status, roomRef: input.roomRef, formation };
    };
    return await waitForRoomChange({
        readResult: () => readResult(),
        isSettled: (result) => result.status === 'ready' || result.status === 'not-found',
        subscribe: (listener) => subscribeRoomFormation(input, listener),
        signal: operationOptions.signal,
        timeoutMs: normalizeWaitTimeoutMs(input.options.timeoutMs),
        toTimedOut: () => readResult('timeout'),
        toAborted: () => readResult('aborted')
    });
}

/**
 * A fenced wait accepts only a layout published at or after the fence;
 * `incomparable` is refused rather than folded into either answer (product
 * decision 29).
 */
export function isRoomLayoutAtOrAfter(
    layout: RallarRoomLayout,
    after: GroupStateCausalRevision | undefined
): boolean {
    if (after === undefined) {
        return true;
    }
    const order = compareGroupCausalRevision(layout.overlay.sourceGroupStateCausalRevision, after);
    return order === 'equal' || order === 'dominates';
}

export async function waitForRoomLayout(input: WaitForRoomLayoutInput): Promise<RallarRoomLayoutWaitResult> {
    const operationOptions = input.resolveOperationOptions(input.options);
    const role = input.options.role ?? 'planned';
    const readResult = (override?: RallarRoomFormationWaitStatus): RallarRoomLayoutWaitResult => {
        const formation = readRoomFormationStatus(input);
        const candidate = formation?.[role];
        const layout = candidate !== undefined && isRoomLayoutAtOrAfter(candidate, input.options.after)
            ? candidate
            : undefined;
        const status = formation === undefined ? 'not-found' : layout === undefined ? 'timeout' : 'ready';
        return { status: override ?? status, roomRef: input.roomRef, layout, formation };
    };
    return await waitForRoomChange({
        readResult: () => readResult(),
        isSettled: (result) => result.status === 'ready' || result.status === 'not-found',
        subscribe: (listener) => subscribeRoomFormation(input, listener),
        signal: operationOptions.signal,
        timeoutMs: normalizeWaitTimeoutMs(input.options.timeoutMs),
        toTimedOut: () => readResult('timeout'),
        toAborted: () => readResult('aborted')
    });
}
