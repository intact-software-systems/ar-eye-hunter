import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import {
    AppInboxType,
    type AppInboxEnqueueInput,
    type AppInboxMessageContext
} from '../../app-inbox/app-inbox-contracts.ts';
import { encodeAppInboxCommand, encodeAppInboxResult } from '../../app-inbox/app-inbox-registration-codecs.ts';
import { GROUP_STATE_APP_INBOX_TOPIC } from '../../app-inbox/app-inbox-topics.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import type { AppInboxHandlerRegistry } from '../../app-inbox/handler/app-inbox-handler-registry.ts';
import type { AppInboxTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import {
    decodeGroupRetentionCommand,
    decodeGroupRetentionIngress,
    type GroupRetentionService
} from './group-retention-service.ts';

interface GroupRetentionInboxDependencies {
    readonly service: GroupRetentionService;
    readonly transactionWriter: AppInboxTransactionWriter;
    readonly wakeQueue: (() => void) | undefined;
}

export function registerGroupRetentionInbox(
    registry: AppInboxHandlerRegistry,
    dependencies: GroupRetentionInboxDependencies
): void {
    registry.registerHandler({
        type: AppInboxType.GROUP_RETENTION_RECONCILE,
        decodeCommand: decodeGroupRetentionCommand,
        encodeResult: (result: GroupRetentionService.Result) => encodeAppInboxResult(result, 'Group retention result'),
        handle: (command, context) => processGroupRetention({ command, context, dependencies })
    });
}

export function toGroupRetentionEnqueue(ingress: GroupRetentionService.Ingress): AppInboxEnqueueInput {
    return {
        type: AppInboxType.GROUP_RETENTION_RECONCILE,
        topicId: GROUP_STATE_APP_INBOX_TOPIC,
        resourceId: ingress.commandId,
        contextId: groupStateGroupStorageKey(ingress.command.groupRef),
        senderId: ingress.serviceId,
        authority: encodeAppInboxCommand(ingress, 'Group retention ingress'),
        data: encodeAppInboxCommand(ingress.command, 'Group retention command')
    };
}

interface ProcessGroupRetentionInput {
    readonly command: GroupRetentionService.Command;
    readonly context: AppInboxMessageContext<GroupRetentionService.Result>;
    readonly dependencies: GroupRetentionInboxDependencies;
}

async function processGroupRetention(input: ProcessGroupRetentionInput): Promise<GroupRetentionService.Result> {
    const { command, context, dependencies } = input;
    const ingress = decodeGroupRetentionIngress(context.enqueue.authority);
    if (!jsonEquals(command, ingress.command) || !jsonEquals(context.enqueue, toGroupRetentionEnqueue(ingress))) {
        throw new TypeError('Retention queue identity differs from its canonical ingress');
    }
    const read = await dependencies.service.read(ingress, context.entry.dequeueAudit.attempts);
    const computed = dependencies.service.compute(read);
    const issue = dependencies.service.validate(read, computed)[0];
    if (issue) {
        throw issue.cause;
    }
    const completionInput = {
        ...dependencies.transactionWriter.readCompletionFacts(context),
        durableResult: { groupRef: command.groupRef, receipt: computed.receipt },
        status: EntityStatus.COMPLETED
    };
    const completion = computeAppInboxCompletion(completionInput);
    const completionIssue = validateAppInboxCompletion(completionInput, completion)[0];
    if (completionIssue) {
        throw completionIssue.cause;
    }
    const result = await dependencies.transactionWriter.writeComputedMutation(
        context,
        completion,
        (transaction) => dependencies.service.write(transaction, computed)
    );
    dependencies.wakeQueue?.();
    return result;
}
