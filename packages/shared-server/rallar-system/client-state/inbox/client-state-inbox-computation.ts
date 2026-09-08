import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { AppInboxExecutionMetadata } from '../../app-inbox/app-inbox-contracts.ts';
import { encodeAppInboxCommand } from '../../app-inbox/app-inbox-registration-codecs.ts';
import {
    computeAppInboxCompletion,
    type AppInboxCompletionComputed,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import {
    computeAppOutboxInsert,
    type AppOutboxInsert
} from '../../app-outbox/app-outbox-insert.ts';
import { validateComputedProjection } from '../../computed-data-validation.ts';
import {
    computeWsSessionConnectGuard,
    computeWsSessionGenerationClosed,
    isWsSessionGenerationClosed,
    type WsSessionGenerationCloseFacts,
    type WsSessionGenerationFacts,
    type WsSessionGenerationGuardFacts,
    type WsSessionGenerationLifecycleComputed,
    type WsSessionGenerationLifecycleRead
} from '../../websocket/ws-session-generation-computation.ts';
import {
    requiresClientWrite,
    toClientStateWritten,
    type ClientExpiredSessionPage,
    type ClientExpiredSessionPageInput,
    type ClientStateWritten
} from '../client-state-service-contracts.ts';
import type {
    ClientMutationCommand,
    ClientMutationComputed,
    ClientMutationComputedWrite,
    ClientMutationRead
} from '../mutation/client-mutation-contracts.ts';
import { computeClientMutation } from '../mutation/compute/compute-client-mutation.ts';
import { assertClientMutationComparison } from '../mutation/result-validation/assert-client-mutation.ts';
import type {
    ClientAuthorisedWsSessionConnectAppInboxPayload,
    ClientAuthorisedWsSessionDisconnectAppInboxPayload
} from './app-client-inbox-contracts.ts';
import type {
    InactiveAuthorisedWsSessionResult
} from './client-state-inbox-result-codec.ts';

type ClientMutationLifecycleInput =
    | Readonly<{
        kind: 'connect';
        facts: WsSessionGenerationGuardFacts;
        read: WsSessionGenerationLifecycleRead;
    }>
    | Readonly<{
        kind: 'disconnect';
        facts: WsSessionGenerationCloseFacts;
        read: WsSessionGenerationLifecycleRead;
    }>;

export type ClientMutationOperationComputed =
    | Readonly<{
        outcome: 'idempotency-conflict';
        mutation: Extract<ClientMutationComputed, { outcome: 'idempotency-conflict'; }>;
    }>
    | Readonly<{
        outcome: 'completed';
        mutation: Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict'; }>;
        lifecycleComputed: WsSessionGenerationLifecycleComputed | undefined;
        durableResult: ClientStateWritten;
        completion: AppInboxCompletionComputed<ClientStateWritten>;
        writes: readonly ClientMutationComputedWrite[];
        committedSnapshots: readonly ClientSnapshot[];
    }>;

export type AuthorisedWsConnectOperationComputed =
    | ClientMutationOperationComputed
    | Readonly<{
        outcome: 'inactive';
        durableResult: InactiveAuthorisedWsSessionResult;
        completion: AppInboxCompletionComputed<InactiveAuthorisedWsSessionResult>;
    }>;

export interface MissingSessionDisconnectComputed {
    readonly lifecycleComputed: WsSessionGenerationLifecycleComputed;
    readonly durableResult: InactiveAuthorisedWsSessionResult;
    readonly completion: AppInboxCompletionComputed<InactiveAuthorisedWsSessionResult>;
}

export type ExpiredSessionsOperationComputed =
    | Readonly<{
        outcome: 'idempotency-conflict';
        mutations: readonly ClientMutationComputed[];
    }>
    | Readonly<{
        outcome: 'completed';
        mutations: readonly Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict'; }>[];
        durableResult: readonly ClientStateWritten[];
        completion: AppInboxCompletionComputed<readonly ClientStateWritten[]>;
        writes: readonly ClientMutationComputedWrite[];
        committedSnapshots: readonly ClientSnapshot[];
        successorWrite: AppOutboxInsert | null;
    }>;

export interface ClientExpiredSessionMutationRead {
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
}

export interface ComputeClientMutationOperationInput {
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
    readonly completionFacts: AppInboxCompletionFacts;
    readonly lifecycle: ClientMutationLifecycleInput | undefined;
}

interface AssertClientMutationOperationInput {
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
    readonly completionFacts: AppInboxCompletionFacts;
    readonly lifecycle: ClientMutationLifecycleInput | undefined;
    readonly computed: ClientMutationOperationComputed;
}

export interface ComputeAuthorisedWsConnectOperationInput {
    readonly connection: ClientAuthorisedWsSessionConnectAppInboxPayload;
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
    readonly lifecycleFacts: WsSessionGenerationFacts;
    readonly lifecycleRead: WsSessionGenerationLifecycleRead;
    readonly completionFacts: AppInboxCompletionFacts;
}

interface AssertAuthorisedWsConnectOperationInput {
    readonly connection: ClientAuthorisedWsSessionConnectAppInboxPayload;
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
    readonly lifecycleFacts: WsSessionGenerationFacts;
    readonly lifecycleRead: WsSessionGenerationLifecycleRead;
    readonly completionFacts: AppInboxCompletionFacts;
    readonly computed: AuthorisedWsConnectOperationComputed;
}

export interface ComputeMissingSessionDisconnectInput {
    readonly commandInput: ClientAuthorisedWsSessionDisconnectAppInboxPayload;
    readonly lifecycleFacts: WsSessionGenerationCloseFacts;
    readonly lifecycleRead: WsSessionGenerationLifecycleRead;
    readonly completionFacts: AppInboxCompletionFacts;
}

interface AssertMissingSessionDisconnectInput {
    readonly commandInput: ClientAuthorisedWsSessionDisconnectAppInboxPayload;
    readonly lifecycleFacts: WsSessionGenerationCloseFacts;
    readonly lifecycleRead: WsSessionGenerationLifecycleRead;
    readonly completionFacts: AppInboxCompletionFacts;
    readonly computed: MissingSessionDisconnectComputed;
}

export interface ComputeExpiredSessionsOperationInput {
    readonly context: AppInboxExecutionMetadata;
    readonly pageInput: ClientExpiredSessionPageInput;
    readonly page: ClientExpiredSessionPage;
    readonly reads: readonly ClientExpiredSessionMutationRead[];
    readonly completionFacts: AppInboxCompletionFacts;
}

interface AssertExpiredSessionsOperationInput {
    readonly context: AppInboxExecutionMetadata;
    readonly pageInput: ClientExpiredSessionPageInput;
    readonly page: ClientExpiredSessionPage;
    readonly reads: readonly ClientExpiredSessionMutationRead[];
    readonly completionFacts: AppInboxCompletionFacts;
    readonly computed: ExpiredSessionsOperationComputed;
}

export function computeClientMutationOperation(
    input: ComputeClientMutationOperationInput
): ClientMutationOperationComputed {
    const mutation = computeClientMutation({ command: input.command, read: input.read });
    if (mutation.outcome === 'idempotency-conflict') {
        return { outcome: 'idempotency-conflict', mutation };
    }
    const lifecycleComputed = input.lifecycle?.kind === 'connect'
        ? computeWsSessionConnectGuard(
            input.lifecycle.facts,
            input.lifecycle.read
        )
        : input.lifecycle?.kind === 'disconnect'
        ? computeWsSessionGenerationClosed(
            input.lifecycle.facts,
            input.lifecycle.read
        )
        : undefined;
    const durableResult = toClientStateWritten(mutation);
    return {
        outcome: 'completed',
        mutation,
        lifecycleComputed,
        durableResult,
        completion: computeCompletion(input.completionFacts, durableResult),
        writes: requiresClientWrite(mutation) ? [mutation] : [],
        committedSnapshots: [mutation.snapshot]
    };
}

export function assertClientMutationOperation(
    input: AssertClientMutationOperationInput
): void {
    const expected = computeClientMutationOperation(input);
    assertExactOperationComputed(
        expected,
        input.computed,
        'Client mutation operation computed'
    );
    assertClientMutationComparison({
        command: input.command,
        read: input.read,
        computed: input.computed.mutation,
        expected: expected.mutation
    });
}

export function computeAuthorisedWsConnectOperation(
    input: ComputeAuthorisedWsConnectOperationInput
): AuthorisedWsConnectOperationComputed {
    if (isWsSessionGenerationClosed(input.lifecycleFacts, input.lifecycleRead)) {
        const durableResult = {
            status: 'inactive',
            sessionId: input.connection.authSession.sessionId,
            generationId: input.connection.generationId
        } as const;
        return {
            outcome: 'inactive',
            durableResult,
            completion: computeCompletion(input.completionFacts, durableResult)
        };
    }
    const mutation = computeClientMutation({ command: input.command, read: input.read });
    if (mutation.outcome === 'idempotency-conflict') {
        return { outcome: 'idempotency-conflict', mutation };
    }
    const lifecycleGuardFacts = toWsSessionGenerationGuardFacts(
        input.connection,
        input.lifecycleFacts
    );
    const lifecycleComputed = computeWsSessionConnectGuard(
        lifecycleGuardFacts,
        input.lifecycleRead
    );
    const durableResult = toClientStateWritten(mutation);
    return {
        outcome: 'completed',
        mutation,
        lifecycleComputed,
        durableResult,
        completion: computeCompletion(input.completionFacts, durableResult),
        writes: requiresClientWrite(mutation) ? [mutation] : [],
        committedSnapshots: [mutation.snapshot]
    };
}

export function assertAuthorisedWsConnectOperation(
    input: AssertAuthorisedWsConnectOperationInput
): void {
    const expected = computeAuthorisedWsConnectOperation(input);
    assertExactOperationComputed(
        expected,
        input.computed,
        'Authorised WebSocket client operation computed'
    );
    if (expected.outcome === 'inactive' || input.computed.outcome === 'inactive') {
        return;
    }
    assertClientMutationComparison({
        command: input.command,
        read: input.read,
        computed: input.computed.mutation,
        expected: expected.mutation
    });
}

export function computeMissingSessionDisconnect(
    input: ComputeMissingSessionDisconnectInput
): MissingSessionDisconnectComputed {
    const lifecycleComputed = computeWsSessionGenerationClosed(
        input.lifecycleFacts,
        input.lifecycleRead
    );
    const durableResult = {
        status: 'inactive',
        sessionId: input.commandInput.connection.authSession.sessionId,
        generationId: input.commandInput.connection.generationId
    } as const;
    return {
        lifecycleComputed,
        durableResult,
        completion: computeCompletion(input.completionFacts, durableResult)
    };
}

export function assertMissingSessionDisconnect(
    input: AssertMissingSessionDisconnectInput
): void {
    assertExactOperationComputed(
        computeMissingSessionDisconnect(input),
        input.computed,
        'Missing-session WebSocket disconnect computed'
    );
}

export function computeExpiredSessionsOperation(
    input: ComputeExpiredSessionsOperationInput
): ExpiredSessionsOperationComputed {
    const mutations = input.reads.map(({ command, read }) => computeClientMutation({ command, read }));
    if (mutations.some((mutation) => mutation.outcome === 'idempotency-conflict')) {
        return { outcome: 'idempotency-conflict', mutations };
    }
    const completedMutations = mutations.filter(
        (mutation): mutation is Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict'; }> =>
            mutation.outcome !== 'idempotency-conflict'
    );
    const applied = completedMutations.filter((mutation) => mutation.outcome === 'write');
    const durableResult = applied.map(toClientStateWritten);
    return {
        outcome: 'completed',
        mutations: completedMutations,
        durableResult,
        completion: computeCompletion(input.completionFacts, durableResult),
        writes: completedMutations.filter(requiresClientWrite),
        committedSnapshots: applied.map((mutation) => mutation.snapshot),
        successorWrite: computeExpiredSessionSuccessorWrite(input)
    };
}

export function assertExpiredSessionsOperation(
    input: AssertExpiredSessionsOperationInput
): void {
    const expected = computeExpiredSessionsOperation(input);
    assertExactOperationComputed(
        expected,
        input.computed,
        'Expired client sessions operation computed'
    );
    for (const [index, { command, read }] of input.reads.entries()) {
        assertClientMutationComparison({
            command,
            read,
            computed: input.computed.mutations[index]!,
            expected: expected.mutations[index]!
        });
    }
}

function computeExpiredSessionSuccessorWrite(
    input: Pick<ComputeExpiredSessionsOperationInput, 'context' | 'pageInput' | 'page' | 'completionFacts'>
): AppOutboxInsert | null {
    const entry = computeExpiredSessionSuccessorEntry({
        context: input.context,
        pageInput: input.pageInput,
        nextAfterKey: input.page.nextAfterKey,
        createdAtEpochMs: input.completionFacts.completedAtEpochMs
    });
    return entry === null ? null : computeAppOutboxInsert(entry);
}

function computeCompletion<Result>(
    facts: AppInboxCompletionFacts,
    durableResult: Result
): AppInboxCompletionComputed<Result> {
    return computeAppInboxCompletion({
        ...facts,
        durableResult,
        status: EntityStatus.COMPLETED
    });
}

function assertExactOperationComputed<Expected, Candidate>(
    expected: Expected,
    candidate: Candidate,
    path: string
): void {
    const projectionIssue = validateComputedProjection(expected, candidate, path)[0];
    if (projectionIssue !== undefined) {
        throw projectionIssue.cause;
    }
}

function toWsSessionGenerationGuardFacts(
    connection: ClientAuthorisedWsSessionConnectAppInboxPayload,
    lifecycleFacts: WsSessionGenerationFacts
): WsSessionGenerationGuardFacts {
    return {
        ...lifecycleFacts,
        expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(
            connection.generationStartedAtEpochMs,
            connection.expiresAtEpochMs
        )
    };
}

interface ComputeExpiredSessionSuccessorEntryInput {
    readonly context: AppInboxExecutionMetadata;
    readonly pageInput: ClientExpiredSessionPageInput;
    readonly nextAfterKey: string | null;
    readonly createdAtEpochMs: number;
}

function computeExpiredSessionSuccessorEntry(
    input: ComputeExpiredSessionSuccessorEntryInput
): ResourceEntry | null {
    const { context, pageInput, nextAfterKey, createdAtEpochMs } = input;
    if (nextAfterKey === null) {
        return null;
    }
    const key = toAppQueueKey({
        topicId: context.entry.key.topicId,
        resourceId: `expire-client-sessions:${pageInput.atEpochMs}:${nextAfterKey}`,
        contextId: context.entry.key.contextId
    });
    const successorInput: ClientExpiredSessionPageInput = {
        atEpochMs: pageInput.atEpochMs,
        afterKey: nextAfterKey
    };
    const enqueue = {
        ...context.enqueue,
        topicId: key.topicId,
        resourceId: key.resourceId,
        contextId: key.contextId,
        data: encodeAppInboxCommand(successorInput, 'Expired client sessions AppInbox continuation')
    };
    const message: ALMessage = {
        id: {
            v: 2,
            msgId: key.resourceId,
            ts: createdAtEpochMs,
            senderId: context.message.id.senderId
        },
        route: key,
        payload: {
            typeId: enqueue.type,
            contentType: 'application/json',
            resource: JSON.stringify(enqueue)
        },
        audit: {
            createdBy: context.message.id.senderId,
            createdTs: createdAtEpochMs
        }
    };
    const createdAt = Temporal.Instant.fromEpochMilliseconds(createdAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key,
        resource: JSON.stringify(message),
        typeId: EnqueuedType.APP_INBOX,
        status: EntityStatus.NEW,
        audit: {
            date: createdAt.toPlainTime(),
            createdBy: context.entry.audit.createdBy,
            createdTs: createdAt,
            expiryTs: context.entry.audit.expiryTs
        },
        dequeueAudit: { attempts: 0 }
    };
}
