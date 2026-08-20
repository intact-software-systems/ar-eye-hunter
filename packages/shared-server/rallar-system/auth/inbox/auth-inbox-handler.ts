import type { AppInboxMutationTransactionWriter } from '@shared-server/rallar-system/services/app-inbox-transaction-writer.ts';

import type { AuthCredentialIssuer } from '../credentials/auth-credential-issuer.ts';
import type { AuthMutationService } from '../auth-mutation-service.ts';
import type { AuthMutationResult } from '../mutation/auth-mutation-contracts.ts';
import { decodeAuthMutationCommand } from '../mutation/decode-auth-mutation-command.ts';
import { captureAuthMutationFacts } from '../mutation/read/capture-auth-mutation-facts.ts';
import type { AppInboxMessageContext } from '../../services/app-inbox-contracts.ts';
import { toAppQueueKey } from '../../services/app-inbox-queue-key.ts';
import {
  AUTH_STATE_APP_INBOX_TOPIC,
  toAuthAppInboxType,
  toAuthCommandContextId,
} from './auth-app-inbox-routing.ts';

export interface AuthInboxHandlerDependencies {
  readonly mutationService: AuthMutationService;
  readonly credentialIssuer: AuthCredentialIssuer;
  readonly transactionWriter: AppInboxMutationTransactionWriter;
}

export class AuthInboxHandler {
  private readonly dependencies: AuthInboxHandlerDependencies;

  constructor(dependencies: AuthInboxHandlerDependencies) {
    this.dependencies = dependencies;
  }

  async processAuthMutation(
    commandCandidate: unknown,
    context: AppInboxMessageContext,
  ): Promise<AuthMutationResult> {
    const command = decodeAuthMutationCommand(commandCandidate);
    const expectedKey = toAppQueueKey({
      topicId: AUTH_STATE_APP_INBOX_TOPIC,
      resourceId: command.requestId,
      contextId: toAuthCommandContextId(command),
    });
    if (
      toAuthAppInboxType(command) !== context.enqueue.type ||
      expectedKey.resourceId !== context.entry.key.resourceId ||
      expectedKey.contextId !== context.entry.key.contextId
    ) {
      throw new TypeError('Auth AppInbox command identity differs from queue key');
    }
    const read = await this.dependencies.mutationService.read(command);
    const facts = await captureAuthMutationFacts(command, this.dependencies.credentialIssuer);
    const computed = this.dependencies.mutationService.compute(command, read, facts);
    this.dependencies.mutationService.validate(command, read, computed);
    return await this.dependencies.transactionWriter.writeMutation(
      context,
      async (transaction) => await this.dependencies.mutationService.write(transaction, computed),
    );
  }
}
