import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupMove, GroupMoveRequest } from '@shared/api/mutation/group-move.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import type { RallarTimingSink } from '../../observability/timing.ts';
import { timeGroupStatePhase, type GroupStatePhaseTiming } from '../inbox/time-group-state-phase.ts';

import { requireExactKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import { decodeGroupMove } from '@shared/api/mutation/decode-group-move.ts';
import {
    AppInboxType,
    toAppInboxCommandAttempt,
    type AppInboxEnqueue,
    type AppInboxMessageContext
} from '../../app-inbox/app-inbox-contracts.ts';
import { encodeAppInboxCommand, encodeAppInboxResult } from '../../app-inbox/app-inbox-registration-codecs.ts';
import { GROUP_STATE_APP_INBOX_TOPIC } from '../../app-inbox/app-inbox-topics.ts';
import type { AppInboxCommandClient } from '../../app-inbox/client/app-inbox-command-client.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import type { AppInboxHandlerRegistry } from '../../app-inbox/handler/app-inbox-handler-registry.ts';
import type { AppInboxTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import { computeSha256CanonicalJson } from '../../protocol/canonical-json.ts';
import { GroupMutationAuthorizationError } from '../group-mutation-authority.ts';
import { GroupMutationRejectedError } from '../mutation/group-mutation-contracts.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import { decodeGroupMoveCommand, type GroupMoveCommand } from './group-move-command.ts';
import { decodeGroupMoveDeadline, type GroupMoveDeadline } from './group-move-outbox.ts';
import type { GroupMoveService } from './group-move-service.ts';

export interface GroupMoveInboxRequest {
    readonly request: GroupMoveRequest;
    readonly traceId: string;
}

interface SubmitGroupMoveInput {
    readonly input: GroupMoveInboxRequest;
    readonly authority: IssuedAuthSession;
    readonly service: GroupMoveService;
    readonly client: AppInboxCommandClient;
}

interface RegisterGroupMoveInboxInput {
    readonly timing: RallarTimingSink | undefined;
    readonly serviceId: string;
    readonly service: GroupMoveService;
    readonly transactionWriter: AppInboxTransactionWriter;
    readonly wakeQueue: (() => void) | undefined;
}

export async function submitGroupMove({ input, authority, service, client }: SubmitGroupMoveInput) {
    const command = service.authorize(input.request, authority);
    const received: AppInboxEnqueue = {
        type: AppInboxType.GROUP_MOVE,
        topicId: GROUP_STATE_APP_INBOX_TOPIC,
        resourceId: command.requestId,
        contextId: `group-move:${
            computeSha256CanonicalJson({
                applicationId: command.source.applicationId,
                workspaceId: command.source.workspaceId,
                principalId: authority.clientId
            })
        }`,
        senderId: authority.clientId,
        data: encodeAppInboxCommand(command, 'Group move command')
    };
    return await client.reserveMaterializedAndWaitForResult({
        received,
        placeholder: { ...received, traceId: input.traceId, data: null },
        materialize: async () => ({
            ...received,
            authority: encodeAppInboxCommand(await service.capture(command, authority), 'Group move ingress')
        })
    }, (value) => {
        const result = decodeGroupMove(value);
        if (
            result.moveId !== command.moveId || !isSameGroupRef(result.source, command.source) ||
            !isSameGroupRef(result.destination, command.destination) ||
            !result.participants.some((participant) =>
                participant.principalId === command.actorPrincipalId && participant.sessionId === command.actorSessionId
            )
        ) {
            throw new TypeError('Group move result identity differs from its command');
        }
        return result;
    });
}

export function registerGroupMoveInbox(registry: AppInboxHandlerRegistry, input: RegisterGroupMoveInboxInput): void {
    registry.registerHandler({
        type: AppInboxType.GROUP_MOVE_EXPIRE,
        decodeCommand: decodeGroupMoveDeadline,
        encodeResult: (result: GroupMove | null) => encodeAppInboxResult(result, 'Group move expiry result'),
        handle: (command, context) => expireGroupMove(input, command, context)
    });
    registry.registerHandler({
        type: AppInboxType.GROUP_MOVE,
        decodeCommand: decodeGroupMoveCommand,
        encodeResult: (result: GroupMove) => encodeAppInboxResult(result, 'Group move result'),
        handle: (command, context) => handleGroupMove(input, command, context)
    });
}

async function expireGroupMove(
    input: RegisterGroupMoveInboxInput,
    command: GroupMoveDeadline,
    context: AppInboxMessageContext<GroupMove | null>
): Promise<GroupMove | null> {
    const timing = groupMoveTiming(input, command, context);
    const authority = requireRecord(context.enqueue.authority, 'Group move expiry authority');
    requireExactKeys(authority, ['command', 'serviceId'], 'Group move expiry authority');
    requireString(authority.serviceId, 'Group move expiry service');
    if (
        !jsonEquals(command, authority.command) ||
        !jsonEquals(context.enqueue, toGroupMoveExpiryEnqueue(command, authority.serviceId))
    ) {
        throw new TypeError('Group move expiry queue identity differs');
    }
    const read = await timeGroupStatePhase(
        timing,
        'read',
        () => input.service.readExpiry(command, context.message.id.traceId)
    );
    const computed = await timeGroupStatePhase(timing, 'compute', () => input.service.computeExpiry(read));
    const issue =
        (await timeGroupStatePhase(timing, 'validate', () => input.service.validateExpiry(read, computed)))[0];
    if (issue) {
        throw issue.cause;
    }
    const completionInput = {
        ...input.transactionWriter.readCompletionFacts(context),
        durableResult: computed.result,
        status: EntityStatus.COMPLETED
    };
    const completion = computeAppInboxCompletion(completionInput);
    const completionIssue = validateAppInboxCompletion(completionInput, completion)[0];
    if (completionIssue) {
        throw completionIssue.cause;
    }
    const result = await timeGroupStatePhase(timing, 'write', () =>
        input.transactionWriter.writeComputedMutation(
            context,
            completion,
            (transaction) => input.service.writeExpiry(transaction, computed)
        ));
    input.wakeQueue?.();
    return result;
}

async function handleGroupMove(
    input: RegisterGroupMoveInboxInput,
    command: GroupMoveCommand,
    context: AppInboxMessageContext<GroupMove>
): Promise<GroupMove> {
    const timing = groupMoveTiming(input, command, context);
    const read = await timeGroupStatePhase(
        timing,
        'read',
        () => input.service.read(context.enqueue.authority, toAppInboxCommandAttempt(context))
    );
    if (!jsonEquals(command, read.ingress.command)) {
        throw new GroupMutationAuthorizationError('Group move ingress and command differ');
    }
    const decision = await timeGroupStatePhase(timing, 'compute', () => input.service.compute(read));
    const issue = (await timeGroupStatePhase(timing, 'validate', () => input.service.validate(read, decision)))[0];
    if (issue) {
        throw issue.cause;
    }
    const computed = decision.fold((rejection) => {
        if (rejection.code === 'optimistic-conflict') {
            throw new RuntimeStateWriteConflictError();
        }
        throw new GroupMutationRejectedError(rejection.message);
    }, (value) => value);
    const completionInput = {
        ...input.transactionWriter.readCompletionFacts(context),
        durableResult: computed.result,
        status: EntityStatus.COMPLETED
    };
    const completion = computeAppInboxCompletion(completionInput);
    const completionIssue = validateAppInboxCompletion(completionInput, completion)[0];
    if (completionIssue) {
        throw completionIssue.cause;
    }
    const result = await timeGroupStatePhase(timing, 'write', () =>
        input.transactionWriter.writeComputedMutation(
            context,
            completion,
            (transaction) => input.service.write(transaction, computed)
        ));
    input.wakeQueue?.();
    return result;
}

function groupMoveTiming(
    input: RegisterGroupMoveInboxInput,
    command: GroupMoveCommand | GroupMoveDeadline,
    context: Pick<AppInboxMessageContext<GroupMove>, 'entry' | 'message'>
): GroupStatePhaseTiming {
    return {
        timing: input.timing,
        component: 'group-move',
        serviceId: input.serviceId,
        requestId: 'requestId' in command ? command.requestId : context.entry.key.resourceId,
        traceId: context.message.id.traceId,
        scope: command.source,
        groupId: command.source.groupId,
        principalId: 'actorPrincipalId' in command ? command.actorPrincipalId : undefined,
        sessionId: 'actorSessionId' in command ? command.actorSessionId : undefined,
        attempt: context.entry.dequeueAudit.attempts
    };
}

export function toGroupMoveExpiryEnqueue(command: GroupMoveDeadline, serviceId: string): AppInboxEnqueue {
    return {
        type: AppInboxType.GROUP_MOVE_EXPIRE,
        topicId: GROUP_STATE_APP_INBOX_TOPIC,
        resourceId: `gm-exp-${computeSha256CanonicalJson(command).slice(7, 34)}`,
        contextId: groupStateGroupStorageKey(command.source),
        senderId: serviceId,
        authority: encodeAppInboxCommand({ command, serviceId }, 'Group move expiry ingress'),
        data: encodeAppInboxCommand(command, 'Group move expiry command')
    };
}

export interface InstallGroupMoveDeadlineInput {
    readonly outboxQueueReader: OutboxQueueReader;
    readonly enqueue: (command: GroupMoveDeadline, traceId: string) => Promise<ResourceEntry>;
    readonly now: () => number;
}

export function installGroupMoveDeadline(input: InstallGroupMoveDeadlineInput): void {
    input.outboxQueueReader.onOutboxMessageDo(AppOutboxType.GROUP_MOVE_DEADLINE, {
        onMessage: async (message) => {
            const command = decodeGroupMoveDeadline(JSON.parse(message.payload.resource));
            if (message.route.topicId !== 'group-move.deadline' || command.expiresAtEpochMs <= message.id.ts) {
                throw new TypeError('Group move deadline work identity differs');
            }
            if (input.now() < command.expiresAtEpochMs) {
                throw new Error('Group move deadline is not due; retry after the deadline');
            }
            await input.enqueue(command, message.id.traceId);
        }
    });
}
