import type { AppInboxMutationTransactionWriter } from '@shared-server/rallar-system/app-inbox/app-inbox-transaction-writer.ts';

import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { AuthMutationService } from '../auth-mutation-service.ts';
import type { AuthCredentialIssuer } from '../credentials/auth-credential-issuer.ts';
import type { AuthMutationResult } from '../mutation/auth-mutation-contracts.ts';
import { decodeAuthMutationIntent } from '../mutation/decode-auth-mutation-intent.ts';
import { materializeAuthMutationIntent } from '../mutation/materialize-auth-mutation-intent.ts';
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
        commandCandidate: unknown,
        context: AppInboxMessageContext
    ): Promise<AuthMutationResult> {
        const intent = decodeAuthMutationIntent(commandCandidate as JsonWireValue);
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
        const read = await this.dependencies.mutationService.read(command);
        const computed = this.dependencies.mutationService.compute(command, read, materialized.facts);
        this.dependencies.mutationService.validate(command, read, computed);
        return await this.dependencies.transactionWriter.writeMutation(
            context,
            async (transaction) => await this.dependencies.mutationService.write(transaction, computed)
        );
    }
}
