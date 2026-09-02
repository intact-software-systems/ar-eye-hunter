import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';

import type { AppInboxExecutionMetadata } from '../../app-inbox/app-inbox-contracts.ts';
import type { AppInboxMutationTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import type { AuthMutationService } from '../auth-mutation-service.ts';
import type { AuthCredentialIssuer } from '../credentials/auth-credential-issuer.ts';
import type { AuthMutationIntent, AuthMutationResult } from '../mutation/auth-mutation-contracts.ts';
import { materializeAuthMutationIntent } from '../mutation/materialize-auth-mutation-intent.ts';
import { writeAuthMutation } from '../mutation/write/write-auth-mutation.ts';
import { toAuthAppInboxType, toAuthIntentContextId } from './auth-app-inbox-routing.ts';
import { computeAuthInboxMutation, validateAuthInboxMutation } from './compute-auth-inbox-mutation.ts';

export interface AuthInboxHandlerDependencies {
    readonly mutationService: Pick<AuthMutationService, 'serviceId' | 'read'>;
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
        context: AppInboxExecutionMetadata
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
            nowEpochMs: this.dependencies.nowEpochMs
        });
        const command = materialized.command;
        const read = {
            command,
            read: await this.dependencies.mutationService.read(command),
            facts: materialized.facts,
            serviceId: this.dependencies.mutationService.serviceId,
            completionFacts: this.dependencies.transactionWriter.readCompletionFacts(context)
        };
        const computed = computeAuthInboxMutation(read);
        const issues = validateAuthInboxMutation(read, computed);
        if (issues[0] !== undefined) {
            throw issues[0].cause;
        }
        return await this.dependencies.transactionWriter.writeMutation(
            context,
            computed.completion,
            async (transaction) => {
                await writeAuthMutation(transaction, computed.mutation);
            }
        );
    }
}
