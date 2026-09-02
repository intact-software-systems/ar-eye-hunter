import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';

import {
    computeAppInboxCompletion,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import {
    computeWsSessionConnectGuard,
    computeWsSessionGenerationClosed,
    isWsSessionGenerationClosed,
    validateWsSessionConnectGuard,
    validateWsSessionGenerationClosed,
    type WsSessionGenerationCloseFacts,
    type WsSessionGenerationFacts,
    type WsSessionGenerationGuardFacts,
    type WsSessionGenerationLifecycleRead
} from '../../websocket/ws-session-generation-computation.ts';
import { requiresClientWrite, toClientStateWritten } from '../client-state-service-contracts.ts';
import type { ClientMutationComputed } from '../mutation/client-mutation-contracts.ts';
import type {
    ClientAuthorisedWsSessionConnectAppInboxPayload,
    ClientAuthorisedWsSessionDisconnectAppInboxPayload
} from './app-client-inbox-contracts.ts';
import {
    computeClientInboxMutation,
    validateClientInboxWrites,
    type ClientInboxMutationRead,
    type ClientStateInboxComputed,
    type ClientStateInboxValidationIssue
} from './client-state-inbox-computation.ts';
import type { AuthorisedWsClientMutationResult } from './client-state-inbox-result-codec.ts';

export interface ClientWsConnectInboxRead {
    readonly facts: WsSessionGenerationGuardFacts;
    readonly lifecycle: WsSessionGenerationLifecycleRead;
    readonly mutation: ClientInboxMutationRead | undefined;
    readonly completionFacts: AppInboxCompletionFacts;
}

export interface ClientWsDisconnectInboxRead {
    readonly facts: WsSessionGenerationCloseFacts;
    readonly lifecycle: WsSessionGenerationLifecycleRead;
    readonly mutation: ClientInboxMutationRead;
    readonly completionFacts: AppInboxCompletionFacts;
}

export interface ClientWsInboxComputed extends ClientStateInboxComputed<AuthorisedWsClientMutationResult> {
    readonly mutation: Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict'; }> | undefined;
}

export function computeClientWsConnectInbox(read: ClientWsConnectInboxRead): ClientWsInboxComputed {
    if (isWsSessionGenerationClosed(read.facts, read.lifecycle)) {
        return computeInactiveClientWsInbox(read);
    }
    if (!read.mutation) {
        throw new TypeError('Open WebSocket generation requires original client mutation facts');
    }
    const mutation = computeClientInboxMutation(read.mutation);
    return {
        mutation,
        clientWrites: requiresClientWrite(mutation) ? [mutation] : [],
        lifecycleWrite: computeWsSessionConnectGuard(read.facts, read.lifecycle),
        completion: computeAppInboxCompletion({
            ...read.completionFacts,
            status: EntityStatus.COMPLETED,
            durableResult: toClientStateWritten(mutation)
        }),
        afterCommitResult: { committedSnapshots: [mutation.snapshot] }
    };
}

export function computeClientWsDisconnectInbox(read: ClientWsDisconnectInboxRead): ClientWsInboxComputed {
    const lifecycleWrite = computeWsSessionGenerationClosed(read.facts, read.lifecycle);
    if (!read.mutation.read.session) {
        return { ...computeInactiveClientWsInbox(read), lifecycleWrite };
    }
    const mutation = computeClientInboxMutation(read.mutation);
    return {
        mutation,
        clientWrites: requiresClientWrite(mutation) ? [mutation] : [],
        lifecycleWrite,
        completion: computeAppInboxCompletion({
            ...read.completionFacts,
            status: EntityStatus.COMPLETED,
            durableResult: toClientStateWritten(mutation)
        }),
        afterCommitResult: { committedSnapshots: [mutation.snapshot] }
    };
}

export function validateClientWsConnectInbox(
    read: ClientWsConnectInboxRead,
    computed: ClientWsInboxComputed
): readonly ClientStateInboxValidationIssue[] {
    const expected = computeClientWsConnectInbox(read);
    const issues = [...validateClientInboxWrites(read.completionFacts, expected, computed)];
    if (issues.length > 0) {
        return issues;
    }
    if (expected.lifecycleWrite && computed.lifecycleWrite) {
        issues.push(...validateWsSessionConnectGuard(read.facts, read.lifecycle, computed.lifecycleWrite));
    }
    return issues;
}

export function validateClientWsDisconnectInbox(
    read: ClientWsDisconnectInboxRead,
    computed: ClientWsInboxComputed
): readonly ClientStateInboxValidationIssue[] {
    const expected = computeClientWsDisconnectInbox(read);
    const issues = [...validateClientInboxWrites(read.completionFacts, expected, computed)];
    if (issues.length > 0) {
        return issues;
    }
    if (computed.lifecycleWrite) {
        issues.push(...validateWsSessionGenerationClosed(read.facts, read.lifecycle, computed.lifecycleWrite));
    }
    return issues;
}

export function toClientWsGenerationFacts(
    connection: ClientAuthorisedWsSessionConnectAppInboxPayload
): WsSessionGenerationFacts {
    return {
        scope: {
            kind: 'client',
            ...connection.scope,
            principalId: connection.principalId,
            clientInstanceId: connection.clientInstanceId
        },
        sessionId: connection.authSession.sessionId,
        generationId: connection.generationId,
        generationStartedAtEpochMs: connection.generationStartedAtEpochMs
    };
}

export function toClientWsConnectGuardFacts(
    connection: ClientAuthorisedWsSessionConnectAppInboxPayload
): WsSessionGenerationGuardFacts {
    return {
        ...toClientWsGenerationFacts(connection),
        expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(
            connection.generationStartedAtEpochMs,
            connection.expiresAtEpochMs
        )
    };
}

export function toClientWsDisconnectFacts(
    input: ClientAuthorisedWsSessionDisconnectAppInboxPayload
): WsSessionGenerationCloseFacts {
    return {
        ...toClientWsGenerationFacts(input.connection),
        disconnectedAtEpochMs: input.disconnectedAtEpochMs,
        reason: input.reason,
        expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(
            input.disconnectedAtEpochMs,
            Math.max(input.disconnectedAtEpochMs, input.connection.expiresAtEpochMs)
        )
    };
}

function computeInactiveClientWsInbox(
    read: ClientWsConnectInboxRead | ClientWsDisconnectInboxRead
): ClientWsInboxComputed {
    return {
        mutation: undefined,
        clientWrites: [],
        lifecycleWrite: undefined,
        completion: computeAppInboxCompletion({
            ...read.completionFacts,
            status: EntityStatus.COMPLETED,
            durableResult: {
                status: 'inactive',
                sessionId: read.facts.sessionId,
                generationId: read.facts.generationId
            }
        }),
        afterCommitResult: { committedSnapshots: [] }
    };
}

