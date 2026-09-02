import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import {
    AppInboxType,
    type AppInboxEnqueueInput,
    type AppInboxExecutionMetadata
} from '../../app-inbox/app-inbox-contracts.ts';
import { encodeAppInboxCommand } from '../../app-inbox/app-inbox-registration-codecs.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion,
    type AppInboxCompletionComputed,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import type { AppInboxMutationTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    computeWsSessionGenerationClosed,
    validateWsSessionGenerationClosed,
    type WsSessionGenerationCloseFacts,
    type WsSessionGenerationFacts,
    type WsSessionGenerationLifecycleComputed,
    type WsSessionGenerationLifecycleRead,
    type WsSessionHighWaterIdentity
} from '../../websocket/ws-session-generation-computation.ts';
import type { WsSessionGenerationLifecycleService } from '../../websocket/ws-session-generation-lifecycle.ts';
import type {
    GroupMutationPreparation,
    GroupStateMutationCommand,
    GroupStateService
} from '../group-state-service-contracts.ts';
import { GroupMutationIdempotencyConflictError } from '../group-state-service.ts';
import { toGroupStateValidationIssue, type GroupStateValidationIssue } from '../group-state-validation-issues.ts';
import type { GroupMutationComputed, GroupMutationRead } from '../mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '../mutation/orchestration/compute-group-mutation.ts';
import { validateGroupMutation } from '../mutation/state-validation/validate-group-mutation.ts';
import type { GroupPresenceSessionCleanupAppInboxPayload } from './group-presence-session-cleanup-app-inbox-payload.ts';

export interface InactiveGroupPresenceResult {
    readonly status: 'inactive';
    readonly sessionId: string;
    readonly generationId: string;
}

export type GroupPresenceConnectRead =
    | InactiveGroupPresenceResult
    | Readonly<{
        status: 'active';
        facts: WsSessionGenerationFacts;
        lifecycleRead: WsSessionGenerationLifecycleRead;
    }>;

interface ReadGroupPresenceConnectInput {
    readonly command: GroupStateMutationCommand;
    readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
}

interface GroupSessionCleanupResult extends InactiveGroupPresenceResult {
    readonly affectedGroups: number;
}

interface ProcessGroupSessionCleanupInput {
    readonly facts: GroupPresenceSessionCleanupAppInboxPayload;
    readonly attemptCount: number;
    readonly context: AppInboxExecutionMetadata;
    readonly groupStateService: GroupStateService;
    readonly transactionWriter: AppInboxMutationTransactionWriter;
    readonly wakeQueue?: () => void;
}

interface GroupSessionCleanupMutationRead {
    readonly command: GroupStateMutationCommand;
    readonly read: GroupMutationRead;
}

interface GroupSessionCleanupInput {
    readonly facts: GroupPresenceSessionCleanupAppInboxPayload;
    readonly lifecycleRead: WsSessionGenerationLifecycleRead;
    readonly mutationReads: readonly GroupSessionCleanupMutationRead[];
    readonly completionFacts: AppInboxCompletionFacts;
}

interface GroupSessionCleanupComputed {
    readonly lifecycle: WsSessionGenerationLifecycleComputed;
    readonly mutations: readonly GroupMutationComputed[];
    readonly completion: AppInboxCompletionComputed<GroupSessionCleanupResult>;
}

export function toGroupSessionCleanupEnqueue(
    input: GroupPresenceSessionCleanupAppInboxPayload,
    serviceId: string
): AppInboxEnqueueInput {
    const connection = input.connection;
    return {
        type: AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
        resourceId: [
            'group-presence-session-cleanup',
            connection.authSession.sessionId,
            connection.generationId
        ]
            .map(encodeURIComponent)
            .join(':'),
        contextId: connection.authSession.sessionId,
        senderId: serviceId,
        data: encodeAppInboxCommand(input, 'Group presence cleanup AppInbox command')
    };
}

export function toExpiredPresenceEnqueue(
    preparation: GroupMutationPreparation
): AppInboxEnqueueInput {
    return {
        type: AppInboxType.GROUP_PRESENCE_EXPIRE,
        resourceId: preparation.queueResourceId,
        authority: decodeJsonWireValue(
            preparation,
            'Expired group presence AppInbox authority'
        ),
        data: { commandId: preparation.command.commandId }
    };
}

export async function readGroupPresenceConnect(
    input: ReadGroupPresenceConnectInput
): Promise<GroupPresenceConnectRead> {
    const operation = input.command.command;
    if (operation.operation !== 'connectPresence') {
        throw new TypeError('Group presence connect command is invalid');
    }
    const observedAtEpochMs = operation.input.connectedAtEpochMs ?? input.command.facts.nowEpochMs;
    const identity = toGroupHighWaterIdentity({
        scope: operation.aggregateRef,
        principalId: operation.input.principalId,
        sessionId: operation.sessionId
    });
    const lifecycle = input.sessionGenerationLifecycle;
    const lifecycleRead = await lifecycle.read(identity);
    if (lifecycle.isObservedAtClosed(identity, observedAtEpochMs, lifecycleRead)) {
        return {
            status: 'inactive',
            sessionId: operation.sessionId,
            generationId: operation.input.generationId
        };
    }
    return {
        status: 'active',
        facts: {
            ...identity,
            generationId: operation.input.generationId,
            generationStartedAtEpochMs: observedAtEpochMs
        },
        lifecycleRead
    };
}

export async function processGroupSessionCleanup(
    input: ProcessGroupSessionCleanupInput
): Promise<GroupSessionCleanupResult> {
    const lifecycle = input.groupStateService.sessionGenerationLifecycle;
    const lifecycleRead = await lifecycle.read(toGroupHighWaterIdentity({
        scope: input.facts.connection.scope,
        principalId: input.facts.connection.principalId,
        sessionId: input.facts.connection.authSession.sessionId
    }));
    const mutationReads = await readGroupSessionCleanupMutations(input);
    const computationInput: GroupSessionCleanupInput = {
        facts: input.facts,
        lifecycleRead,
        mutationReads,
        completionFacts: input.transactionWriter.readCompletionFacts(input.context)
    };
    const computed = computeGroupSessionCleanup(computationInput);
    const issues = validateGroupSessionCleanup(computationInput, computed);
    if (issues.length > 0) {
        throw issues[0].cause;
    }
    for (const [index, mutation] of computed.mutations.entries()) {
        if (mutation.outcome === 'idempotency-conflict') {
            throw new GroupMutationIdempotencyConflictError(
                mutationReads[index].command.command.commandId,
                mutation.existingCommandHash,
                mutation.receivedCommandHash
            );
        }
    }
    const result = await input.transactionWriter.writeMutation(
        input.context,
        computed.completion,
        async (transaction) => {
            await lifecycle.write(transaction, computed.lifecycle);
            for (const mutation of computed.mutations) {
                if (mutation.outcome === 'write') {
                    await input.groupStateService.write(transaction, mutation);
                }
            }
        }
    );
    input.wakeQueue?.();
    return result;
}

function computeGroupSessionCleanup(input: GroupSessionCleanupInput): GroupSessionCleanupComputed {
    return {
        lifecycle: computeWsSessionGenerationClosed(toGroupCloseFacts(input.facts), input.lifecycleRead),
        mutations: input.mutationReads.map(({ command, read }) =>
            computeGroupMutation({ command: command.command, read, facts: command.facts })
        ),
        completion: computeAppInboxCompletion({
            ...input.completionFacts,
            durableResult: computeGroupSessionCleanupResult(input),
            status: EntityStatus.COMPLETED
        })
    };
}

function validateGroupSessionCleanup(
    input: GroupSessionCleanupInput,
    computed: GroupSessionCleanupComputed
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (computed.mutations.length !== input.mutationReads.length) {
        issues.push(toGroupStateValidationIssue('mutations', 'Group session cleanup must retain every read mutation.'));
    }
    for (const [index, mutation] of computed.mutations.entries()) {
        const original = input.mutationReads[index];
        if (original) {
            const { command, read } = original;
            issues.push(
                ...validateGroupMutation({ command: command.command, read, facts: command.facts, computed: mutation })
            );
        }
    }
    issues.push(
        ...validateWsSessionGenerationClosed(toGroupCloseFacts(input.facts), input.lifecycleRead, computed.lifecycle)
    );
    issues.push(...validateAppInboxCompletion({
        ...input.completionFacts,
        durableResult: computeGroupSessionCleanupResult(input),
        status: EntityStatus.COMPLETED
    }, computed.completion));
    return issues;
}

function computeGroupSessionCleanupResult(input: GroupSessionCleanupInput): GroupSessionCleanupResult {
    return {
        status: 'inactive',
        sessionId: input.facts.connection.authSession.sessionId,
        generationId: input.facts.connection.generationId,
        affectedGroups: input.mutationReads.length
    };
}

async function readGroupSessionCleanupMutations(
    input: ProcessGroupSessionCleanupInput
): Promise<readonly GroupSessionCleanupMutationRead[]> {
    const preparations = await input.groupStateService.prepareSessionCleanupMutations({
        scope: input.facts.connection.scope,
        authSession: input.facts.connection.authSession,
        principalId: input.facts.connection.principalId,
        disconnectedAtEpochMs: input.facts.disconnectedAtEpochMs
    });
    return await Promise.all(preparations.map(async (prepared) => {
        const command: GroupStateMutationCommand = {
            authorityProof: prepared.authorityProof,
            descriptor: prepared.descriptor,
            command: prepared.command,
            facts: { ...prepared.facts, attemptCount: input.attemptCount }
        };
        const read = await input.groupStateService.read(command);
        return { command, read };
    }));
}

function toGroupHighWaterIdentity(
    input: Readonly<{
        scope: Readonly<{ applicationId: string; workspaceId: string; }>;
        principalId: string;
        sessionId: string;
    }>
): WsSessionHighWaterIdentity {
    return {
        scope: {
            kind: 'group',
            applicationId: input.scope.applicationId,
            workspaceId: input.scope.workspaceId,
            principalId: input.principalId
        },
        sessionId: input.sessionId
    };
}

function toGroupCloseFacts(
    input: GroupPresenceSessionCleanupAppInboxPayload
): WsSessionGenerationCloseFacts {
    const connection = input.connection;
    return {
        ...toGroupHighWaterIdentity({
            scope: connection.scope,
            principalId: connection.principalId,
            sessionId: connection.authSession.sessionId
        }),
        generationId: connection.generationId,
        generationStartedAtEpochMs: connection.generationStartedAtEpochMs,
        disconnectedAtEpochMs: input.disconnectedAtEpochMs,
        reason: input.reason,
        expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(input.disconnectedAtEpochMs)
    };
}
