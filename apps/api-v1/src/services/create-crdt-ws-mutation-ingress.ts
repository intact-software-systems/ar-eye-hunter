import type {
  RallarCrdtServerMutationIngress,
} from '@shared-server/crdt/RallarCrdtServer.ts';
import type {
  AppCrdtInboxService,
} from '@shared-server/rallar-system/services/AppCrdtInboxService.ts';

export function createCrdtWsMutationIngress(
  appCrdt: AppCrdtInboxService,
  serverId: string,
): RallarCrdtServerMutationIngress {
  return {
    enqueueUpdate: async (accepted) => {
      const trusted = accepted.trusted;
      await appCrdt.createAndEnqueueAppend({
        update: accepted.envelope,
        actor: {
          actorId: trusted.senderId,
          principalId: trusted.principalId,
          sessionId: trusted.sessionId ?? trusted.senderId,
          serverId,
        },
        responseAudience: {
          kind: accepted.envelope.document.scope === 'room'
            ? 'room'
            : accepted.envelope.document.scope === 'principal'
            ? 'principal'
            : 'app',
          senderSessionId: trusted.sessionId ?? trusted.senderId,
          topicId: accepted.raw.route.topicId,
          contextId: accepted.raw.route.contextId,
        },
        capturedAtEpochMs: trusted.receivedAtEpochMs,
        expireAtEpochMs: trusted.receivedAtEpochMs + 60_000,
      });
    },
  };
}
