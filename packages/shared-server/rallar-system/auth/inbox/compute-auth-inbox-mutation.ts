import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    computeAppInboxCompletion,
    validateAppInboxCompletionFacts,
    type AppInboxCompletionComputed,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import { validateAppInboxComputedProjection } from '../../app-inbox/handler/app-inbox-computed-validation.ts';
import type { AuthMutationComputed, AuthMutationResult } from '../mutation/auth-mutation-contracts.ts';
import { computeAuthMutation, type ComputeAuthMutationInput } from '../mutation/compute/compute-auth-mutation.ts';
import { validateAuthMutation } from '../mutation/validate/validate-auth-mutation.ts';

export interface AuthInboxMutationRead extends ComputeAuthMutationInput {
    readonly completionFacts: AppInboxCompletionFacts;
}

export interface AuthInboxMutationComputed {
    readonly mutation: AuthMutationComputed;
    readonly completion: AppInboxCompletionComputed<AuthMutationResult>;
}

export interface AuthInboxMutationValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: Error;
}

export function computeAuthInboxMutation(read: AuthInboxMutationRead): AuthInboxMutationComputed {
    const mutation = computeAuthMutation(read);
    const completion = computeAppInboxCompletion({
        ...read.completionFacts,
        durableResult: mutation.result,
        status: EntityStatus.COMPLETED
    });
    return { mutation, completion };
}

export function validateAuthInboxMutation(
    read: AuthInboxMutationRead,
    computed: AuthInboxMutationComputed
): readonly AuthInboxMutationValidationIssue[] {
    const issues: AuthInboxMutationValidationIssue[] = [];
    try {
        const expected = computeAuthInboxMutation(read);
        issues.push(...validateAppInboxComputedProjection(expected, computed, 'computed'));
        if (issues.length > 0) {
            return issues;
        }
        validateAuthMutation(read.command, read.read, computed.mutation);
        issues.push(...validateAppInboxCompletionFacts({
            ...read.completionFacts,
            status: EntityStatus.COMPLETED
        }));
    }
    catch (caught) {
        const cause = caught instanceof Error ? caught : new Error(String(caught));
        issues.push({ path: 'mutation', message: cause.message, cause });
    }
    return issues;
}

