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
): ReturnType<typeof validateComputedProjection> {
    const durableResult = toRtcRttAppInboxResult(computed.mutation, input.requestId);
    const completionInput = {
        ...input.completionFacts,
        durableResult,
        status: EntityStatus.COMPLETED
    } as const;
    return [
        ...validateComputedProjection(
            durableResult,
            computed.durableResult,
            'computed.durableResult'
        ),
        ...validateAppInboxCompletion(completionInput, computed.completion)
    ];
}
