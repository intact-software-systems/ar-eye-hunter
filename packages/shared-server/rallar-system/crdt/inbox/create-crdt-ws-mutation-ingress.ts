import type { RallarCrdtServerMutationIngress } from '../realtime/rallar-crdt-server-contracts.ts';

import type { AppCrdtInboxService } from './app-crdt-inbox-service.ts';

export function createCrdtWsMutationIngress(
    appCrdtInboxService: AppCrdtInboxService
): RallarCrdtServerMutationIngress {
    return {
        enqueueUpdate: async (accepted) => {
            const trusted = accepted.trusted;
            await appCrdtInboxService.createAndEnqueueAuthenticatedAppend({
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
                    contextId: accepted.raw.route.contextId
                },
                capturedAtEpochMs: trusted.receivedAtEpochMs,
                expireAtEpochMs: trusted.receivedAtEpochMs
            });
        }
    };
}
