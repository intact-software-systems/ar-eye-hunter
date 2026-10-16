import type { ClientSession, ClientSnapshot } from '@shared/api/client-types.ts';
import { Either } from '@shared/resilience/Either.ts';

export namespace BrowserOwnWsConnectionGeneration {
    export interface Input {
        /** The browser's socket client; its `ws` is replaced on every reconnect. */
        readonly socket: Readonly<{ ws?: Readonly<{ readyState: number; }>; }>;
        readonly sessionId: string;
        /** The caller's own client snapshot as the server holds it, in the scope the socket was authorised for. */
        readonly readOwnClientSnapshot: (signal: AbortSignal | undefined) => Promise<ClientSnapshot>;
    }
}

/**
 * The server stamps the authorised socket's generation on the session's client entry before the socket upgrades, so a
 * client snapshot read after the current socket opened names it; a cached snapshot can still name the socket that
 * closed before a reconnect, so it is never consulted.
 */
export class BrowserOwnWsConnectionGeneration {
    readonly #input: BrowserOwnWsConnectionGeneration.Input;
    readonly #generationIdBySocket = new WeakMap<object, string>();

    public constructor(input: BrowserOwnWsConnectionGeneration.Input) {
        this.#input = input;
    }

    public async read(signal?: AbortSignal): Promise<Either<Error, string>> {
        const socket = this.#readOpenSocket();
        if (socket === undefined) {
            return Either.ofLeft(new Error('Cannot connect room presence: the WebSocket is not open.'));
        }
        const known = this.#generationIdBySocket.get(socket);
        if (known !== undefined) {
            return Either.ofRight(known);
        }
        const snapshot = await this.#readOwnClientSnapshot(signal);
        if (snapshot.left !== undefined) {
            return Either.ofLeft(snapshot.left);
        }
        if (this.#readOpenSocket() !== socket) {
            return Either.ofLeft(
                new Error('Cannot connect room presence: the WebSocket reconnected while its generation was read.')
            );
        }
        const generationId = snapshot.right?.activeSessions.find((session) =>
            isAuthorisedWsSession(session, this.#input.sessionId)
        )?.generationId;
        if (generationId === undefined) {
            return Either.ofLeft(
                new Error('Cannot connect room presence: the WebSocket connection generation is not known yet.')
            );
        }
        this.#generationIdBySocket.set(socket, generationId);
        return Either.ofRight(generationId);
    }

    /** The open socket's generation when a read already established it; no request. */
    public readKnown(): string | undefined {
        const socket = this.#readOpenSocket();
        return socket === undefined ? undefined : this.#generationIdBySocket.get(socket);
    }

    async #readOwnClientSnapshot(signal: AbortSignal | undefined): Promise<Either<Error, ClientSnapshot>> {
        try {
            return Either.ofRight(await this.#input.readOwnClientSnapshot(signal));
        }
        catch (caught) {
            return Either.ofLeft(caught instanceof Error ? caught : new Error(String(caught)));
        }
    }

    #readOpenSocket(): Readonly<{ readyState: number; }> | undefined {
        const socket = this.#input.socket.ws;
        return socket?.readyState === WebSocket.OPEN ? socket : undefined;
    }
}

function isAuthorisedWsSession(session: ClientSession, sessionId: string): boolean {
    return session.sessionId === sessionId && session.transport === 'ws' &&
        session.connectionId === session.generationId;
}
