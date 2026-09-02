import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    computeAppInboxCompletion,
    validateAppInboxCompletionFacts,
    type AppInboxCompletionComputed,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import { validateAppInboxComputedProjection } from '../../app-inbox/handler/app-inbox-computed-validation.ts';
import type { WsSessionGenerationLifecycleComputed } from '../../websocket/ws-session-generation-computation.ts';
import {
    requiresClientWrite,
    toClientStateWritten,
    type ClientStateWritten
} from '../client-state-service-contracts.ts';
import type {
    ClientMutationCommand,
    ClientMutationComputed,
    ClientMutationComputedWrite,
    ClientMutationRead
} from '../mutation/client-mutation-contracts.ts';
import { computeClientMutation } from '../mutation/compute/compute-client-mutation.ts';
import { ClientMutationIdempotencyConflictError } from '../mutation/result-validation/validate-client-mutation.ts';

export interface ClientInboxMutationRead {
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
}

export interface ClientStateInboxRead {
    readonly mutation: ClientInboxMutationRead;
    readonly completionFacts: AppInboxCompletionFacts;
}

export interface ClientStateInboxAfterCommitResult {
    readonly committedSnapshots: readonly ClientSnapshot[];
}

export interface ClientStateInboxComputed<Result> {
    readonly clientWrites: readonly ClientMutationComputedWrite[];
    readonly lifecycleWrite: WsSessionGenerationLifecycleComputed | undefined;
    readonly completion: AppInboxCompletionComputed<Result>;
    readonly afterCommitResult: ClientStateInboxAfterCommitResult;
}

export interface ClientStateCommandInboxComputed extends ClientStateInboxComputed<ClientStateWritten> {
    readonly mutation: Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict'; }>;
}

export interface ClientStateInboxValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: Error;
}

export function computeClientStateInboxMutation(read: ClientStateInboxRead): ClientStateCommandInboxComputed {
    const mutation = computeClientInboxMutation(read.mutation);
    return {
        mutation,
        clientWrites: requiresClientWrite(mutation) ? [mutation] : [],
        lifecycleWrite: undefined,
        completion: computeAppInboxCompletion({
            ...read.completionFacts,
            durableResult: toClientStateWritten(mutation),
            status: EntityStatus.COMPLETED
        }),
        afterCommitResult: { committedSnapshots: [mutation.snapshot] }
    };
}

export function validateClientStateInboxMutation(
    read: ClientStateInboxRead,
    computed: ClientStateCommandInboxComputed
): readonly ClientStateInboxValidationIssue[] {
    const expected = computeClientStateInboxMutation(read);
    return validateClientInboxWrites(read.completionFacts, expected, computed);
}

export function computeClientInboxMutation(
    read: ClientInboxMutationRead
): Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict'; }> {
    const computed = computeClientMutation(read);
    if (computed.outcome === 'idempotency-conflict') {
        throw new ClientMutationIdempotencyConflictError(
            read.command.commandId,
            computed.existingCommandHash,
            computed.receivedCommandHash
        );
    }
    return computed;
}

export function validateClientInboxWrites<Result>(
    facts: AppInboxCompletionFacts,
    expected: ClientStateInboxComputed<Result>,
    computed: ClientStateInboxComputed<Result>
): readonly ClientStateInboxValidationIssue[] {
    const issues = validateAppInboxComputedProjection(expected, computed, 'computed');
    if (issues.length > 0) {
        return issues;
    }
    return validateAppInboxCompletionFacts({
        ...facts,
        status: EntityStatus.COMPLETED
    });
}

