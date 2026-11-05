import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarLifecycleParticipant } from '@shared-web/browser/session/rallar-lifecycle-coordinator.ts';
import { emitBrowserStateReadDiagnostic } from '@shared-web/browser/state-read/diagnostics.ts';
import { toScopedGroupKey } from '@shared/api/api-type-utils.ts';
import type { GroupPresencePublicationKey, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

export namespace BrowserRoomPresenceReassertion {
    export interface Input {
        readonly presence: PresencePort;
        readonly readPublicationKey: () => Promise<GroupPresencePublicationKey | null>;
        /** Every re-assert names a fresh presence generation: the closed row's own one is spent. */
        readonly newGenerationId: () => string;
    }

    /** The room flows' side of the register: a room is remembered once its presence arrived and forgotten on departure. */
    export interface EnteredRooms {
        rememberEnteredRoom(roomRef: GroupRef): void;
        forgetEnteredRoom(roomRef: GroupRef): void;
    }

    export interface PresenceRequest {
        readonly roomRef: GroupRef;
        readonly context: ApiMiddleware;
        readonly generationId: string;
        readonly connectionGenerationId: string;
        readonly publicationKey: GroupPresencePublicationKey | null;
        /** Throws once a newer open, a departure or a detach made this re-assert obsolete. */
        readonly assertCurrent: () => void;
    }

    export interface PresencePort {
        /** The room snapshot the connect answered; an HTTP refusal throws. */
        connectPresence(request: PresenceRequest): Promise<GroupSnapshot | undefined>;
        /** True once a read of the room lists the session under the request's presence generation. */
        readSessionPresent(snapshot: GroupSnapshot, request: PresenceRequest): Promise<boolean>;
    }

    export type Outcome = 'reasserted' | 'inactive' | 'refused';
}

interface EnteredRoom {
    readonly roomRef: GroupRef;
}

interface AttachedConnection {
    readonly context: ApiMiddleware;
    /** The latest socket open; a re-assert another open overtook leaves the room to that open. */
    currentOpen: object;
}

/** `unchanged`: nothing is known yet, so the room stays remembered for the next open. */
type PresenceAnswer = 'present' | 'missing' | 'refused' | 'unchanged';

const SOCKET_CALLBACK_ID = 'rallar:room-presence-reassertion';

/**
 * A same-session socket reopen re-asserts the session's presence in every room the page entered and has not left,
 * under the reopened socket's connection generation, so the closed socket's cleanup reads as an omission rather than a
 * departure. Attach runs after the initial connect opened the socket, so every open it observes is a reopen.
 */
export class BrowserRoomPresenceReassertion
    implements RallarLifecycleParticipant, BrowserRoomPresenceReassertion.EnteredRooms {
    public readonly id = 'room-presence-reassertion';
    /** After the topic subscriptions (45), so a reopen re-asserts their elections before the rooms' presence. */
    public readonly order = 46;
    readonly #input: BrowserRoomPresenceReassertion.Input;
    readonly #entered = new Map<string, EnteredRoom>();
    #connection: AttachedConnection | undefined;

    public constructor(input: BrowserRoomPresenceReassertion.Input) {
        this.#input = input;
    }

    public rememberEnteredRoom(roomRef: GroupRef): void {
        const { applicationId, workspaceId, groupId } = roomRef;
        this.#entered.set(toScopedGroupKey(roomRef), { roomRef: { applicationId, workspaceId, groupId } });
    }

    public forgetEnteredRoom(roomRef: GroupRef): void {
        this.#entered.delete(toScopedGroupKey(roomRef));
    }

    public attach(context: ApiMiddleware): void {
        const connection: AttachedConnection = { context, currentOpen: {} };
        this.#connection = connection;
        context.middleware.webSocketQueueBox.socket.onWebsocketCallbacksDo(SOCKET_CALLBACK_ID, {
            onOpen: () => this.#reassertAll(connection)
        });
    }

    /** The session's sockets are gone: its rooms are re-entered explicitly by the next connection. */
    public detach(): void {
        const connection = this.#connection;
        if (connection === undefined) {
            return;
        }
        this.#connection = undefined;
        connection.context.middleware.webSocketQueueBox.socket.removeWebsocketCallbackById(SOCKET_CALLBACK_ID);
        this.#entered.clear();
    }

    #reassertAll(connection: AttachedConnection): void {
        const open = {};
        connection.currentOpen = open;
        for (const [key, room] of this.#entered) {
            void this.#reassert({ connection, open, key, room })
                .catch((error: Error) => console.warn(`Room presence re-assertion for ${key} failed:`, error));
        }
    }

    async #reassert(attempt: ReassertAttempt): Promise<void> {
        const startedAtMs = Date.now();
        const first = await this.#connectOnce(attempt);
        const answer = first === 'missing' && this.#isCurrent(attempt) ? await this.#connectOnce(attempt) : first;
        if (!this.#isCurrent(attempt) || answer === 'unchanged') {
            return;
        }
        if (answer !== 'present') {
            this.#entered.delete(attempt.key);
        }
        emitBrowserStateReadDiagnostic({
            name: 'rallar.browser.state-read',
            feature: 'group',
            operation: 'room-presence-reassertion',
            result: toReassertionOutcome(answer),
            durationMs: Date.now() - startedAtMs
        });
    }

    async #connectOnce(attempt: ReassertAttempt): Promise<PresenceAnswer> {
        const { context } = attempt.connection;
        const generation = await context.middleware.ownWsConnectionGeneration.read();
        if (generation.right === undefined) {
            return 'unchanged';
        }
        const request: BrowserRoomPresenceReassertion.PresenceRequest = {
            roomRef: attempt.room.roomRef,
            context,
            generationId: this.#input.newGenerationId(),
            connectionGenerationId: generation.right,
            publicationKey: await this.#input.readPublicationKey(),
            assertCurrent: () => {
                if (!this.#isCurrent(attempt)) {
                    throw new DOMException('Room presence re-assertion is obsolete', 'AbortError');
                }
            }
        };
        let snapshot: GroupSnapshot | undefined;
        try {
            snapshot = await this.#input.presence.connectPresence(request);
        }
        catch (error) {
            return toRefusedPresenceAnswer(error);
        }
        return snapshot !== undefined && await this.#input.presence.readSessionPresent(snapshot, request)
            ? 'present'
            : 'missing';
    }

    #isCurrent({ connection, open, key, room }: ReassertAttempt): boolean {
        return this.#connection === connection && connection.currentOpen === open && this.#entered.get(key) === room;
    }
}

interface ReassertAttempt {
    readonly connection: AttachedConnection;
    readonly open: object;
    readonly key: string;
    readonly room: EnteredRoom;
}

/**
 * A 400, 403 or 404 is the server's refusal, except `stale-generation`: a newer socket opened while this connect was in
 * flight, and that open re-asserts. Any other failure leaves the room for the next open.
 */
function toRefusedPresenceAnswer(error: unknown): PresenceAnswer {
    if (!(error instanceof ApiHttpError) || ![400, 403, 404].includes(error.status)) {
        return 'unchanged';
    }
    const code = error.mutationFailure?.code ?? error.policyError?.code;
    return code === 'stale-generation' ? 'unchanged' : 'refused';
}

function toReassertionOutcome(answer: Exclude<PresenceAnswer, 'unchanged'>): BrowserRoomPresenceReassertion.Outcome {
    switch (answer) {
        case 'present':
            return 'reasserted';
        case 'missing':
            return 'inactive';
        case 'refused':
            return 'refused';
    }
}
