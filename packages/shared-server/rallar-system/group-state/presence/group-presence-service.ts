import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import type { AppInboxEnqueueInput } from '../../app-inbox/app-inbox-queue-client.ts';
import { AppInboxType } from '../../app-inbox/app-inbox-queue-client.ts';
import type {
    WsSessionGenerationCloseFacts,
    WsSessionGenerationLifecycleComputed,
    WsSessionGenerationLifecycleService,
    WsSessionHighWaterIdentity
} from '../../websocket/ws-session-generation-lifecycle.ts';
import type {
    GroupMutationPreparation,
    GroupStateMutationCommand,
    GroupStateMutationService,
    GroupStateService
} from '../group-state-service-contracts.ts';
import type { GroupMutationComputed } from '../mutation/group-mutation-contracts.ts';
import type { GroupPresenceSessionCleanupAppInboxPayload } from './group-presence-session-cleanup-app-inbox-payload.ts';

type WriteMutation = <Result>(
    write: (transaction: PSqlTransactionSql) => Promise<Result>
) => Promise<Result>;

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
        lifecycleGuard: WsSessionGenerationLifecycleComputed;
    }>;

interface ProcessGroupPresenceConnectInput {
    readonly command: GroupStateMutationCommand;
    readonly mutationService: GroupStateMutationService;
    readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
}

interface GroupSessionCleanupResult extends InactiveGroupPresenceResult {
    readonly affectedGroups: number;
}

export type ExpiredGroupPresenceEnqueue = AppInboxEnqueueInput<Readonly<{ commandId: string; }>>;

export function toGroupSessionCleanupEnqueue(
    input: GroupPresenceSessionCleanupAppInboxPayload,
    serviceId: string
): AppInboxEnqueueInput<GroupPresenceSessionCleanupAppInboxPayload> {
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
        data: input
    };
}

export function toExpiredPresenceEnqueue(
    preparation: GroupMutationPreparation
): ExpiredGroupPresenceEnqueue {
    return {
        type: AppInboxType.GROUP_PRESENCE_EXPIRE,
        resourceId: preparation.queueResourceId,
        authority: preparation,
        data: { commandId: preparation.command.commandId }
    };
}

export async function processGroupPresenceConnect(
    input: ProcessGroupPresenceConnectInput
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
    const lifecycleRead = await lifecycle.read(identity);
    if (lifecycle.isObservedAtClosed(identity, observedAtEpochMs, lifecycleRead)) {
        return {
            status: 'inactive',
            sessionId: operation.sessionId,
            generationId: operation.input.generationId
        };
    }
    const read = await input.mutationService.read(input.command);
    const computed = input.mutationService.compute(input.command, read);
    input.mutationService.validate(input.command, read, computed);
    const lifecycleGuard = lifecycle.computeConnectGuard(
        {
            ...identity,
            generationId: operation.input.generationId,
            generationStartedAtEpochMs: observedAtEpochMs,
            expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(observedAtEpochMs)
        },
        lifecycleRead
    );
    return { status: 'ready-to-commit', computed, lifecycleGuard };
}

export async function processGroupSessionCleanup(
    input: Readonly<{
        facts: GroupPresenceSessionCleanupAppInboxPayload;
        attemptCount: number;
        groupStateService: GroupStateService;
        writeMutation: WriteMutation;
        wakeQueue?: () => void;
    }>
): Promise<GroupSessionCleanupResult> {
    const closeFacts = toGroupCloseFacts(input.facts);
    const lifecycle = input.groupStateService.sessionGenerationLifecycle;
    const lifecycleRead = await lifecycle.read(closeFacts);
    const lifecycleComputed = lifecycle.computeClosed(closeFacts, lifecycleRead);
    const preparations = await input.groupStateService.prepareSessionCleanupMutations({
        scope: input.facts.connection.scope,
        authSession: input.facts.connection.authSession,
        principalId: input.facts.connection.principalId,
        disconnectedAtEpochMs: input.facts.disconnectedAtEpochMs
    });
    const mutations = await Promise.all(
        preparations.map(async (prepared) => {
            const command: GroupStateMutationCommand = {
                authorityProof: prepared.authorityProof,
                descriptor: prepared.descriptor,
                command: prepared.command,
                facts: { ...prepared.facts, attemptCount: input.attemptCount }
            };
            const read = await input.groupStateService.read(command);
            const computed = input.groupStateService.compute(command, read);
            input.groupStateService.validate(command, read, computed);
            return computed;
        })
    );
    const result = await input.writeMutation(async (transaction) => {
        await lifecycle.write(transaction, lifecycleComputed);
        for (const computed of mutations) {
            if (computed.outcome === 'write') {
                await input.groupStateService.write(transaction, computed);
            }
        }
        return {
            status: 'inactive',
            sessionId: input.facts.connection.authSession.sessionId,
            generationId: input.facts.connection.generationId,
            affectedGroups: mutations.length
        } as const;
    });
    input.wakeQueue?.();
    return result;
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
