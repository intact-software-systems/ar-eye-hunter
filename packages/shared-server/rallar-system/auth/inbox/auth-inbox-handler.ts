import type { AppInboxMutationTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';

import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import type { AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import type { AuthMutationService } from '../auth-mutation-service.ts';
import type { AuthCredentialIssuer } from '../credentials/auth-credential-issuer.ts';
import type { AuthMutationIntent, AuthMutationResult } from '../mutation/auth-mutation-contracts.ts';
import { materializeAuthMutationIntent } from '../mutation/materialize-auth-mutation-intent.ts';
import { toAuthAppInboxType, toAuthIntentContextId } from './auth-app-inbox-routing.ts';

export interface AuthInboxHandlerDependencies {
    readonly mutationService: AuthMutationService;
    readonly credentialIssuer: AuthCredentialIssuer;
    readonly transactionWriter: Pick<
        AppInboxMutationTransactionWriter,
        'readCompletionFacts' | 'writeComputedMutation'
    >;
    readonly nowEpochMs: () => number;
}

export class AuthInboxHandler {
    private readonly dependencies: AuthInboxHandlerDependencies;

    constructor(dependencies: AuthInboxHandlerDependencies) {
        this.dependencies = dependencies;
    }

    async processAuthMutation(
        intent: AuthMutationIntent,
        context: AppInboxMessageContext<AuthMutationResult>
    ): Promise<AuthMutationResult> {
        const expectedKey = toAppQueueKey({
            topicId: toAuthAppInboxType(intent),
            resourceId: intent.requestId,
            contextId: toAuthIntentContextId(intent)
        });
        if (
            toAuthAppInboxType(intent) !== context.enqueue.type ||
            expectedKey.topicId !== context.entry.key.topicId ||
            expectedKey.resourceId !== context.entry.key.resourceId ||
            expectedKey.contextId !== context.entry.key.contextId
        ) {
            throw new TypeError('Auth AppInbox command identity differs from queue key');
        }
        const materialized = await materializeAuthMutationIntent(intent, {
            credentialIssuer: this.dependencies.credentialIssuer,
            nowEpochMs: this.dependencies.nowEpochMs,
            serviceId: this.dependencies.mutationService.serviceId
        });
        const command = materialized.command;
        const read = await this.dependencies.mutationService.read(command);
        const computed = this.dependencies.mutationService.compute(command, read, materialized.facts);
        this.dependencies.mutationService.validate({
            command,
            read,
            facts: materialized.facts,
            computed
        });
        const completionInput = {
            ...this.dependencies.transactionWriter.readCompletionFacts(context),
            durableResult: computed.result,
            status: EntityStatus.COMPLETED
        } as const;
        const completion = computeAppInboxCompletion(completionInput);
        const completionIssues = validateAppInboxCompletion(completionInput, completion);
        if (completionIssues[0] !== undefined) {
            throw completionIssues[0].cause;
        }
        return await this.dependencies.transactionWriter.writeComputedMutation(
            context,
            completion,
            async (transaction) => {
                await this.dependencies.mutationService.write(transaction, computed);
            }
        );
    }
}
