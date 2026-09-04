import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion,
    type AppInboxCompletionComputed,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import { validateComputedProjection } from '../../computed-data-validation.ts';
import { computeRtcRttMutation } from '../mutation/compute-rtc-rtt-mutation.ts';
import type {
    RtcRttMutationCommand,
    RtcRttMutationComputed,
    RtcRttMutationFacts,
    RtcRttMutationRead
} from '../mutation/rtc-rtt-mutation-contracts.ts';
import { validateRtcRttMutation } from '../mutation/validate-rtc-rtt-mutation.ts';
import { toRtcRttAppInboxResult, type RtcRttAppInboxResult } from './rtc-rtt-app-inbox-result.ts';

interface RtcRttAppInboxMutationInput {
    readonly command: RtcRttMutationCommand;
    readonly read: RtcRttMutationRead;
    readonly facts: RtcRttMutationFacts;
    readonly requestId: string;
    readonly completionFacts: AppInboxCompletionFacts;
}

export interface RtcRttAppInboxMutationComputed {
    readonly mutation: RtcRttMutationComputed;
    readonly durableResult: RtcRttAppInboxResult;
    readonly completion: AppInboxCompletionComputed<RtcRttAppInboxResult>;
}

export function computeRtcRttAppInboxMutation(
    input: RtcRttAppInboxMutationInput
): RtcRttAppInboxMutationComputed {
    const mutation = computeRtcRttMutation(input);
    const durableResult = toRtcRttAppInboxResult(mutation, input.requestId);
    return {
        mutation,
        durableResult,
        completion: computeAppInboxCompletion({
            ...input.completionFacts,
            durableResult,
            status: EntityStatus.COMPLETED
        })
    };
}

export function validateRtcRttAppInboxMutation(
    input: RtcRttAppInboxMutationInput,
    computed: RtcRttAppInboxMutationComputed
): void {
    const projectionIssue = validateComputedProjection(
        computeRtcRttAppInboxMutation(input),
        computed,
        'computed'
    )[0];
    if (projectionIssue !== undefined) {
        throw projectionIssue.cause;
    }
    validateRtcRttMutation({ ...input, computed: computed.mutation });
    const completionIssue = validateAppInboxCompletion(
        {
            ...input.completionFacts,
            durableResult: computed.durableResult,
            status: EntityStatus.COMPLETED
        },
        computed.completion
    )[0];
    if (completionIssue !== undefined) {
        throw completionIssue.cause;
    }
}
