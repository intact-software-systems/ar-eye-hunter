import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { API_CREATE_WS_PATH, toApiWsUrl } from '@shared/websocket/to-api-ws-url.ts';
import { assert, assertEquals } from '@std/assert';
import type { ApiV1RtcTopologyProofApi, ProofSession } from '../topology-replay/api-v1-rtc-topology-proof-api.mts';

export namespace ClusterProofSocket {
    export interface OpenInput {
        readonly api: ApiV1RtcTopologyProofApi;
        readonly session: ProofSession;
        readonly scope: StateScope;
    }

    export interface Labels {
        readonly failure: string;
        readonly frame: string;
        readonly closeReason: string;
    }
}

/** Records every decoded AL frame of one authenticated socket; a proof socket never reconnects. */
export class ClusterProofSocket {
    readonly frames: ALMessage[] = [];
    readonly closeCodes: number[] = [];
    readonly socket: WebSocket;
    readonly #labels: ClusterProofSocket.Labels;
    #failure: Error | null = null;

    protected constructor(socket: WebSocket, labels: ClusterProofSocket.Labels) {
        this.socket = socket;
        this.#labels = labels;
        socket.addEventListener('message', (event) => this.#record(event));
        socket.addEventListener('close', (event) => this.closeCodes.push(event.code));
        socket.addEventListener('error', () => {
            this.#failure = new Error(labels.failure);
        });
    }

    protected static async connect(input: ClusterProofSocket.OpenInput): Promise<WebSocket> {
        const ticket = await input.api.issueWebSocketTicket(input.session);
        return new WebSocket(toApiWsUrl({
            wsBaseUrl: input.session.wsBaseUrl,
            createWsPath: API_CREATE_WS_PATH,
            sessionId: input.session.sessionId,
            ticket,
            scope: input.scope
        }));
    }

    protected async waitForOpen(): Promise<void> {
        await waitForProofCondition(() => this.socket.readyState === WebSocket.OPEN, 'authenticated socket open');
    }

    async waitForFrame(predicate: (frame: ALMessage) => boolean, after = 0): Promise<ALMessage> {
        await waitForProofCondition(() => {
            if (this.#failure) {
                throw this.#failure;
            }
            this.assertOpen();
            return this.frames.slice(after).some(predicate);
        }, this.#labels.frame);
        return this.frames.slice(after).find(predicate)!;
    }

    assertOpen(): void {
        assertEquals(this.socket.readyState, WebSocket.OPEN, 'Original websocket remains open');
        assertEquals(this.closeCodes, [], 'No socket reconnect can rescue the proof');
        assertEquals(this.#failure, null);
    }

    send(frame: ALMessage): void {
        this.socket.send(JSON.stringify(frame));
    }

    close(): void {
        this.socket.close(1000, this.#labels.closeReason);
    }

    /** A frame the proof refuses fails the socket; the next wait rethrows it. */
    protected validateFrame(_frame: ALMessage): void {}

    #record(event: MessageEvent): void {
        try {
            assert(typeof event.data === 'string');
            const decoded = decodeALMessageValue(JSON.parse(event.data));
            if (decoded.left) {
                throw new TypeError(decoded.left.message);
            }
            const frame = decoded.right;
            assert(frame, 'Decoded AL message is required');
            this.validateFrame(frame);
            this.frames.push(frame);
        }
        catch (error) {
            this.#failure = error instanceof Error ? error : new Error(String(error));
        }
    }
}

export async function waitForProofCondition(
    read: () => boolean | Promise<boolean>,
    label: string,
    timeoutMs = 15_000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!await read()) {
        assert(Date.now() < deadline, `Timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
