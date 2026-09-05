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
import { readAuthMutationAttempt } from '../mutation/read-auth-mutation-attempt.ts';
import { toAuthAppInboxType, toAuthIntentContextId } from './auth-app-inbox-routing.ts';

export interface AuthInboxHandlerDependencies {
    readonly mutationService: AuthMutationService;
    readonly credentialIssuer: AuthCredentialIssuer;
    readonly transactionWriter: AppInboxMutationTransactionWriter;
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
        const read = await readAuthMutationAttempt(intent, {
            credentialIssuer: this.dependencies.credentialIssuer,
            mutationService: this.dependencies.mutationService,
            nowEpochMs: this.dependencies.nowEpochMs
        });
        const completionFacts = this.dependencies.transactionWriter.readCompletionFacts(context);
        const computedMutation = this.dependencies.mutationService.compute(
            read.command,
            read.authoritativeState,
            read.facts
        );
        const validationInput = {
            command: read.command,
            read: read.authoritativeState,
            facts: read.facts,
            computed: computedMutation
        };
        const mutationIssues = this.dependencies.mutationService.validate(validationInput);
        if (mutationIssues[0] !== undefined) {
            throw mutationIssues[0].cause;
        }
        const completionInput = {
            ...completionFacts,
            durableResult: computedMutation.result,
            status: EntityStatus.COMPLETED
        } as const;
        const computedCompletion = computeAppInboxCompletion(completionInput);
        const completionIssues = validateAppInboxCompletion(completionInput, computedCompletion);
        if (completionIssues[0] !== undefined) {
            throw completionIssues[0].cause;
        }
        return await this.dependencies.transactionWriter.writeComputedMutation(
            context,
            computedCompletion,
            async (transaction) => {
                await this.dependencies.mutationService.write(transaction, computedMutation);
            }
        );
    }
}
