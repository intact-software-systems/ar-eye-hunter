import type { RallarCrdtServerMutationIngress } from '@shared-server/crdt/RallarCrdtServer.ts';
import type {
  AppCrdtInboxService,
} from '@shared-server/rallar-system/services/AppCrdtInboxService.ts';

export function createCrdtWsMutationIngress(
  appCrdt: AppCrdtInboxService,
  _serverId: string,
): RallarCrdtServerMutationIngress {
  return {
    enqueueUpdate: async (accepted) => {
      const trusted = accepted.trusted;
      await appCrdt.createAndEnqueueAuthenticatedAppend({
        update: accepted.envelope,
        deliveryId: accepted.raw.id.msgId,
        trustedSessionId: trusted.sessionId,
        responseAudience: {
          kind: accepted.envelope.document.scope === 'room'
            ? 'room'
            : accepted.envelope.document.scope === 'principal'
            ? 'principal'
            : 'app',
          topicId: accepted.raw.route.topicId,
          contextId: accepted.raw.route.contextId,
        },
        capturedAtEpochMs: trusted.receivedAtEpochMs,
        expireAtEpochMs: trusted.receivedAtEpochMs,
      });
    },
  };
}
