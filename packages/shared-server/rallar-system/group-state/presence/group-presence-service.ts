import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { AppInboxEnqueue, AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';
import { AppInboxType } from '../../app-inbox/app-inbox-contracts.ts';
import { encodeAppInboxCommand } from '../../app-inbox/app-inbox-registration-codecs.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import type { AppInboxMutationTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import {
    validateWsSessionConnectGuard,
    validateWsSessionGenerationClosed,
    type WsSessionGenerationCloseFacts,
    type WsSessionGenerationGuardFacts,
    type WsSessionGenerationLifecycleComputed,
    type WsSessionGenerationLifecycleRead,
    type WsSessionHighWaterIdentity
} from '../../websocket/ws-session-generation-computation.ts';
import type { WsSessionGenerationLifecycleService } from '../../websocket/ws-session-generation-lifecycle.ts';
import type {
    GroupStateMutationCommand,
    GroupStateMutationService,
    GroupStateService
} from '../group-state-service-contracts.ts';
import { GroupMutationIdempotencyConflictError } from '../group-state-service.ts';
import type { GroupMutationComputed } from '../mutation/group-mutation-contracts.ts';
import type { GroupMutationRead } from '../mutation/group-mutation-contracts.ts';
import { toGroupMutationAttemptFacts } from '../mutation/to-group-mutation-attempt-facts.ts';
import type { GroupPresenceSessionCleanupAppInboxPayload } from './group-presence-session-cleanup-app-inbox-payload.ts';

export interface InactiveGroupPresenceResult {
    readonly status: 'inactive';
    readonly sessionId: string;
    readonly generationId: string;
}

export type GroupPresenceConnectOutcome =
    | InactiveGroupPresenceResult
    | Readonly<{
        status: 'ready-to-commit';
        computed: GroupMutationComputed;
        read: GroupMutationRead;
        lifecycleGuardFacts: WsSessionGenerationGuardFacts;
        lifecycleRead: WsSessionGenerationLifecycleRead;
        lifecycleGuard: WsSessionGenerationLifecycleComputed;
    }>;

interface ReadAndComputeGroupPresenceConnectInput {
    readonly command: GroupStateMutationCommand;
    readonly mutationService: GroupStateMutationService;
    readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
}

interface AssertGroupStateMutationValidInput {
    readonly service: GroupStateMutationService;
    readonly command: GroupStateMutationCommand;
    readonly read: GroupMutationRead;
    readonly computed: GroupMutationComputed;
}

interface GroupSessionCleanupResult extends InactiveGroupPresenceResult {
    readonly affectedGroups: number;
}

export function toGroupSessionCleanupEnqueue(
    input: GroupPresenceSessionCleanupAppInboxPayload,
    serviceId: string
): AppInboxEnqueue {
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

export async function readAndComputeGroupPresenceConnect(
    input: ReadAndComputeGroupPresenceConnectInput
): Promise<GroupPresenceConnectOutcome> {
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
    // Settled rather than all: a closed session is inactive whatever its discarded mutation read did.
    const [lifecycleReading, mutationReading] = await Promise.allSettled([
        lifecycle.read(identity),
        input.mutationService.read(input.command)
    ]);
    const lifecycleRead = requireSettledValue(lifecycleReading);
    if (lifecycle.isObservedAtClosed(identity, observedAtEpochMs, lifecycleRead)) {
        return {
            status: 'inactive',
            sessionId: operation.sessionId,
            generationId: operation.input.generationId
        };
    }
    const read = requireSettledValue(mutationReading);
    const computed = input.mutationService.compute(input.command, read);
    const lifecycleGuardFacts = {
        ...identity,
        generationId: operation.input.generationId,
        generationStartedAtEpochMs: observedAtEpochMs,
        expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(observedAtEpochMs)
    };
    const lifecycleGuard = lifecycle.computeConnectGuard(lifecycleGuardFacts, lifecycleRead);
    return { status: 'ready-to-commit', computed, read, lifecycleGuardFacts, lifecycleRead, lifecycleGuard };
}

function requireSettledValue<Value>(result: PromiseSettledResult<Value>): Value {
    if (result.status === 'rejected') {
        throw result.reason;
    }
    return result.value;
}

export async function writeGroupSessionCleanup(
    input: Readonly<{
        facts: GroupPresenceSessionCleanupAppInboxPayload;
        attemptCount: number;
        laneNowEpochMs: number;
        context: AppInboxMessageContext<GroupSessionCleanupResult>;
        groupStateService: GroupStateService;
        transactionWriter: Pick<AppInboxMutationTransactionWriter, 'readCompletionFacts' | 'writeComputedMutation'>;
        wakeQueue?: () => void;
    }>
): Promise<GroupSessionCleanupResult> {
    const closeFacts = toGroupCloseFacts(input.facts);
    const lifecycle = input.groupStateService.sessionGenerationLifecycle;
    const lifecycleRead = await lifecycle.read(closeFacts);
    const lifecycleComputed = lifecycle.computeClosed(closeFacts, lifecycleRead);
    const ingresses = await input.groupStateService.captureSessionCleanupMutationIngresses({
        scope: input.facts.connection.scope,
        authSession: input.facts.connection.authSession,
        principalId: input.facts.connection.principalId,
        connectionGenerationId: input.facts.connection.generationId,
        disconnectedAtEpochMs: input.facts.disconnectedAtEpochMs
    });
    const mutations = await Promise.all(
        ingresses.map(async (ingress) => {
            const command: GroupStateMutationCommand = {
                authorityProof: ingress.authorityProof,
                descriptor: ingress.descriptor,
                command: ingress.command,
                facts: toGroupMutationAttemptFacts({
                    ingressFacts: ingress.facts,
                    attemptCount: input.attemptCount,
                    laneNowEpochMs: input.laneNowEpochMs,
                    traceId: input.context.message.id.traceId
                })
            };
            const read = await input.groupStateService.read(command);
            const computed = input.groupStateService.compute(command, read);
            return { command, read, computed };
        })
    );
    const durableResult = {
        status: 'inactive',
        sessionId: input.facts.connection.authSession.sessionId,
        generationId: input.facts.connection.generationId,
        affectedGroups: mutations.length
    } as const;
    const completionInput = {
        ...input.transactionWriter.readCompletionFacts(input.context),
        durableResult,
        status: EntityStatus.COMPLETED
    } as const;
    const completion = computeAppInboxCompletion(completionInput);
    validateWsSessionGenerationClosed(closeFacts, lifecycleRead, lifecycleComputed);
    for (const mutation of mutations) {
        assertGroupStateMutationValid({
            service: input.groupStateService,
            command: mutation.command,
            read: mutation.read,
            computed: mutation.computed
        });
        if (mutation.computed.outcome === 'idempotency-conflict') {
            throw new GroupMutationIdempotencyConflictError(
                mutation.command.command.commandId,
                mutation.computed.existingCommandHash,
                mutation.computed.receivedCommandHash
            );
        }
    }
    const completionIssues = validateAppInboxCompletion(completionInput, completion);
    if (completionIssues[0] !== undefined) {
        throw completionIssues[0].cause;
    }
    const result = await input.transactionWriter.writeComputedMutation(
        input.context,
        completion,
        async (transaction) => {
            await lifecycle.write(transaction, lifecycleComputed);
            for (const mutation of mutations) {
                if (mutation.computed.outcome === 'write') {
                    await input.groupStateService.write(transaction, mutation.computed);
                }
            }
        }
    );
    input.wakeQueue?.();
    return result;
}

function assertGroupStateMutationValid(input: AssertGroupStateMutationValidInput): void {
    const issue = input.service.validate(input.command, input.read, input.computed)[0];
    if (issue !== undefined) {
        throw issue.cause;
    }
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
