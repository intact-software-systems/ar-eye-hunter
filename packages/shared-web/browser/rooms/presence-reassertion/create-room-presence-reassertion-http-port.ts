import { toStateScope } from '@shared/api/api-type-utils.ts';

import { readRoomSessionPresence } from '../join-room.ts';
import { createStateGroupPresenceCommand } from '../room-group-state-workflows.ts';
import type { BrowserRoomPresenceReassertion } from './browser-room-presence-reassertion.ts';

/** The re-assertion's presence connect and arrival wait over the room flows' own REST commands. */
export function createRoomPresenceReassertionHttpPort(): BrowserRoomPresenceReassertion.PresencePort {
    return {
        connectPresence: async (request) => {
            const { session } = request.context;
            return await createStateGroupPresenceCommand({
                groupId: request.roomRef.groupId,
                principalId: session.clientId,
                sessionId: session.sessionId,
                generationId: request.generationId,
                connectionGenerationId: request.connectionGenerationId,
                publicationKey: request.publicationKey,
                scope: toStateScope(request.roomRef),
                authSession: session,
                assertCurrent: request.assertCurrent
            }).run();
        },
        readSessionPresent: async (snapshot, request) => {
            const { session } = request.context;
            try {
                await readRoomSessionPresence({
                    snapshot,
                    sessionId: session.sessionId,
                    generationId: request.generationId,
                    present: true,
                    fence: { session, assertCurrent: request.assertCurrent },
                    context: request.context,
                    options: {},
                    minPresenceRevision: 0
                });
                return true;
            }
            catch {
                return false;
            }
        }
    };
}
