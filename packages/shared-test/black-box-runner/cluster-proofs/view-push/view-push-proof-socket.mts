import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { decodeViewInvalidationMessage, decodeViewResync } from '@shared/api/views/view-invalidation.ts';
import { assertEquals } from '@std/assert';
import { ClusterProofSocket } from '../cluster-proof-socket.mts';

/** Validates view frames and records room controls; the original socket survives the subscriber-loss phase. */
export class ViewPushProofSocket extends ClusterProofSocket {
    private constructor(socket: WebSocket) {
        super(socket, {
            failure: 'View proof socket failed',
            frame: 'matching view frame',
            closeReason: 'view-push-proof-complete'
        });
    }

    static async open(input: ClusterProofSocket.OpenInput): Promise<ViewPushProofSocket> {
        const observer = new ViewPushProofSocket(await ClusterProofSocket.connect(input));
        await observer.waitForOpen();
        return observer;
    }

    protected override validateFrame(frame: ALMessage): void {
        if (frame.route.topicId === AppTopics.viewInvalidated) {
            decodeViewInvalidationMessage(frame);
        }
        else if (frame.route.topicId === AppTopics.viewResync) {
            assertEquals(frame.payload.typeId, AppTopics.viewResync);
            decodeViewResync(JSON.parse(frame.payload.resource));
        }
    }
}
