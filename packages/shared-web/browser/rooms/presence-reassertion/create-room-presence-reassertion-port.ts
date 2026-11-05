import type { RallarStateSnapshotAcceptanceInput } from '@shared-web/browser/state-cache/rallar-state-store.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { isRoomPresenceWaitExhausted, readRoomSessionPresence } from '../join-room.ts';
import { createStateGroupPresenceCommand } from '../room-group-state-workflows.ts';
import type { BrowserRoomPresenceReassertion } from './browser-room-presence-reassertion.ts';

/**
 * The re-assertion's presence connect and arrival wait over the room flows' own REST commands, and its adoption of
 * the arrived snapshot through the state store the room flows accept snapshots into.
 */
export function createRoomPresenceReassertionPort(
    acceptSnapshots: (input: RallarStateSnapshotAcceptanceInput) => Promise<void>
): BrowserRoomPresenceReassertion.PresencePort {
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
        readSessionArrival: async (snapshot, request) => {
            const { session } = request.context;
            try {
                const arrived = await readRoomSessionPresence({
                    snapshot,
                    sessionId: session.sessionId,
                    generationId: request.generationId,
                    present: true,
                    fence: { session, assertCurrent: request.assertCurrent },
                    context: request.context,
                    options: {},
                    minPresenceRevision: 0
                });
                return Either.ofRight({ status: 'arrived', snapshot: arrived });
            }
            catch (caught) {
                const error = toError(caught);
                return isRoomPresenceWaitExhausted(error) ? Either.ofRight({ status: 'absent' }) : Either.ofLeft(error);
            }
        },
        adoptRoomSnapshot: async (snapshot, request) => {
            await acceptSnapshots({
                context: request.context,
                clients: [],
                groups: [snapshot],
                scope: toStateScope(request.roomRef),
                assertCurrent: request.assertCurrent
            });
        }
    };
}
