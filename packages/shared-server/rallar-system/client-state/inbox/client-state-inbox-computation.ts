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
    CLIENT_EXPIRED_SESSION_PAGE_SIZE,
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
import { validateClientMutationAuthorityPolicy } from '../mutation/result-validation/validate-client-mutation-authority-policy.ts';
import {
    assertClientMutationComputed,
    validateClientMutation
} from '../mutation/result-validation/validate-client-mutation.ts';
import type { ClientMutationValidationIssue } from '../validation/client-mutation-rejection.ts';
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

type ClientMutationOperationComputed =
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

type AuthorisedWsConnectOperationComputed =
    | ClientMutationOperationComputed
    | Readonly<{
        outcome: 'inactive';
        durableResult: InactiveAuthorisedWsSessionResult;
        completion: AppInboxCompletionComputed<InactiveAuthorisedWsSessionResult>;
    }>;

interface MissingSessionDisconnectComputed {
    readonly lifecycleComputed: WsSessionGenerationLifecycleComputed;
    readonly durableResult: InactiveAuthorisedWsSessionResult;
    readonly completion: AppInboxCompletionComputed<InactiveAuthorisedWsSessionResult>;
}

type ExpiredSessionsOperationComputed =
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

interface ComputeClientMutationOperationInput {
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
    readonly completionFacts: AppInboxCompletionFacts;
    readonly lifecycle: ClientMutationLifecycleInput | undefined;
}

interface ValidateClientMutationOperationInput {
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
    readonly completionFacts: AppInboxCompletionFacts;
    readonly lifecycle: ClientMutationLifecycleInput | undefined;
    readonly computed: ClientMutationOperationComputed;
}

interface ComputeAuthorisedWsConnectOperationInput {
    readonly connection: ClientAuthorisedWsSessionConnectAppInboxPayload;
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
    readonly lifecycleFacts: WsSessionGenerationFacts;
    readonly lifecycleRead: WsSessionGenerationLifecycleRead;
    readonly completionFacts: AppInboxCompletionFacts;
}

interface ValidateAuthorisedWsConnectOperationInput {
    readonly connection: ClientAuthorisedWsSessionConnectAppInboxPayload;
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
    readonly lifecycleFacts: WsSessionGenerationFacts;
    readonly lifecycleRead: WsSessionGenerationLifecycleRead;
    readonly completionFacts: AppInboxCompletionFacts;
    readonly computed: AuthorisedWsConnectOperationComputed;
}

interface ComputeMissingSessionDisconnectInput {
    readonly commandInput: ClientAuthorisedWsSessionDisconnectAppInboxPayload;
    readonly lifecycleFacts: WsSessionGenerationCloseFacts;
    readonly lifecycleRead: WsSessionGenerationLifecycleRead;
    readonly completionFacts: AppInboxCompletionFacts;
}

interface ValidateMissingSessionDisconnectInput {
    readonly commandInput: ClientAuthorisedWsSessionDisconnectAppInboxPayload;
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
    readonly lifecycleFacts: WsSessionGenerationCloseFacts;
    readonly lifecycleRead: WsSessionGenerationLifecycleRead;
    readonly completionFacts: AppInboxCompletionFacts;
    readonly computed: MissingSessionDisconnectComputed;
}

interface ComputeExpiredSessionsOperationInput {
    readonly context: AppInboxExecutionMetadata;
    readonly pageInput: ClientExpiredSessionPageInput;
    readonly page: ClientExpiredSessionPage;
    readonly reads: readonly ClientExpiredSessionMutationRead[];
    readonly completionFacts: AppInboxCompletionFacts;
}

interface ValidateExpiredSessionsOperationInput {
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

export function validateClientMutationOperation(
    input: ValidateClientMutationOperationInput
): readonly ClientMutationValidationIssue[] {
    return validateClientMutation({
        command: input.command,
        read: input.read
    });
}

export function assertClientMutationOperationComputed(
    input: ValidateClientMutationOperationInput
): void {
    assertExactOperationComputed(
        computeClientMutationOperation(input),
        input.computed,
        'Client mutation operation computed'
    );
    assertClientMutationComputed({
        command: input.command,
        read: input.read,
        computed: input.computed.mutation
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

export function validateAuthorisedWsConnectPolicy(
    input: ValidateAuthorisedWsConnectOperationInput
): readonly ClientMutationValidationIssue[] {
    return validateClientMutationAuthorityPolicy(input.command, input.read);
}

export function assertAuthorisedWsConnectComputed(
    input: ValidateAuthorisedWsConnectOperationInput
): void {
    assertExactOperationComputed(
        computeAuthorisedWsConnectOperation(input),
        input.computed,
        'Authorised WebSocket client operation computed'
    );
    if (input.computed.outcome === 'inactive') {
        return;
    }
    assertClientMutationComputed({
        command: input.command,
        read: input.read,
        computed: input.computed.mutation
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

export function validateMissingSessionDisconnectPolicy(
    input: ValidateMissingSessionDisconnectInput
): readonly ClientMutationValidationIssue[] {
    return validateClientMutationAuthorityPolicy(input.command, input.read);
}

export function assertMissingSessionDisconnectComputed(
    input: ValidateMissingSessionDisconnectInput
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

export function validateExpiredSessionsPolicy(
    input: ValidateExpiredSessionsOperationInput
): readonly ClientMutationValidationIssue[] {
    return input.reads.flatMap(({ command, read }) => validateClientMutationAuthorityPolicy(command, read));
}

export function assertExpiredSessionsOperation(
    input: ValidateExpiredSessionsOperationInput
): void {
    assertExactOperationComputed(
        computeExpiredSessionsOperation(input),
        input.computed,
        'Expired client sessions operation computed'
    );
    for (const [index, { command, read }] of input.reads.entries()) {
        assertClientMutationComputed({
            command,
            read,
            computed: input.computed.mutations[index]!
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
        data: encodeAppInboxCommand(
            successorInput,
            'Expired client sessions AppInbox continuation'
        )
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
