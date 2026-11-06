import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { decodeViewInvalidationMessage, decodeViewResync } from '@shared/api/views/view-invalidation.ts';
import { assert, assertEquals } from '@std/assert';
import { ApiV1RtcTopologyProofApi, type ProofSession } from '../../topology-replay/api-v1-rtc-topology-proof-api.mts';

export namespace ViewPushProofSocket {
    export interface OpenInput {
        readonly api: ApiV1RtcTopologyProofApi;
        readonly session: ProofSession;
        readonly scope: StateScope;
    }
}

/** Validates view frames and records room controls; the original socket survives the subscriber-loss phase. */
export class ViewPushProofSocket {
    readonly frames: ALMessage[] = [];
    readonly closeCodes: number[] = [];
    readonly socket: WebSocket;
    #failure: Error | null = null;

    private constructor(socket: WebSocket) {
        this.socket = socket;
        socket.addEventListener('message', (event) => this.#record(event));
        socket.addEventListener('close', (event) => this.closeCodes.push(event.code));
        socket.addEventListener('error', () => {
            this.#failure = new Error('View proof socket failed');
        });
    }

    static async open(input: ViewPushProofSocket.OpenInput): Promise<ViewPushProofSocket> {
        const ticket = await input.api.issueWebSocketTicket(input.session);
        const query = new URLSearchParams({ ticket, ...input.scope });
        const socket = new WebSocket(`${input.session.wsBaseUrl}/api/ws/${input.session.sessionId}?${query}`);
        const observer = new ViewPushProofSocket(socket);
        await waitForProofCondition(() => socket.readyState === WebSocket.OPEN, 'authenticated socket open');
        return observer;
    }

    async waitForFrame(predicate: (frame: ALMessage) => boolean, after = 0): Promise<ALMessage> {
        await waitForProofCondition(() => {
            if (this.#failure) {
                throw this.#failure;
            }
            this.assertOpen();
            return this.frames.slice(after).some(predicate);
        }, 'matching view frame');
        return this.frames.slice(after).find(predicate)!;
    }

    assertOpen(): void {
        assertEquals(this.socket.readyState, WebSocket.OPEN, 'Original websocket remains open');
        assertEquals(this.closeCodes, [], 'No socket reconnect can rescue the proof');
        assertEquals(this.#failure, null);
    }

    close(): void {
        this.socket.close(1000, 'view-push-proof-complete');
    }

    #record(event: MessageEvent): void {
        try {
            assert(typeof event.data === 'string');
            const decoded = decodeALMessageValue(JSON.parse(event.data));
            if (decoded.left) {
                throw new TypeError(decoded.left.message);
            }
            const frame = decoded.right;
            assert(frame, 'Decoded AL message is required');
            if (frame.route.topicId === AppTopics.viewInvalidated) {
                decodeViewInvalidationMessage(frame);
            }
            else if (frame.route.topicId === AppTopics.viewResync) {
                assertEquals(frame.payload.typeId, AppTopics.viewResync);
                decodeViewResync(JSON.parse(frame.payload.resource));
            }
            this.frames.push(frame);
        }
        catch (error) {
            this.#failure = error instanceof Error ? error : new Error(String(error));
        }
    }
}

export async function waitForProofCondition(read: () => boolean | Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!await read()) {
        assert(Date.now() < deadline, `Timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
