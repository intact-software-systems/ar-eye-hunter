import type { ArenaTournamentSnapshot } from '@ar-eye-hunter/arena-tournament-snapshot.ts';
import {
    ARENA_TOURNAMENT_SNAPSHOT_TOPIC,
    decodeArenaTournamentFrame,
    decodeArenaTournamentFrameHeader,
    isArenaTournamentFrameMessage,
    isArenaTournamentRoomFrame
} from '@ar-eye-hunter/arena-tournament-stream.ts';
import type { AuthenticatedResource } from '@shared-web/browser/api/authenticated-resource.ts';
import { subscribeViewInvalidations } from '@shared-web/browser/api/subscribe-view-invalidations.ts';
import type { SubscribeViewRecovery } from '@shared-web/browser/api/subscribe-view-recovery.ts';
import type { RallarMessage } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';

export namespace ArenaTournamentFrames {
    export interface Owner {
        attempt(): AuthenticatedResource.ReadInput | null;
        current(attempt: AuthenticatedResource.ReadInput): boolean;
        isActive(): boolean;
        snapshot(): ArenaTournamentSnapshot | null | undefined;
        publish(attempt: AuthenticatedResource.ReadInput, snapshot: ArenaTournamentSnapshot): void;
    }
    export interface CapturedFrame {
        readonly message: RallarMessage<ApiJsonValue>;
        readonly attempt: AuthenticatedResource.ReadInput;
        readonly generation: number;
        readonly attemptId: string;
        readonly attemptRevision: number;
    }
}

/** Decodes at most one frame at a time and retains only the newest pending revision. */
export class ArenaTournamentFrames {
    private readonly room: GroupRef;
    private streamGeneration = 0;
    private decoding = false;
    private trailingFrame: ArenaTournamentFrames.CapturedFrame | null = null;
    private authorizedRead: AuthenticatedResource.ReadInput | null = null;
    private readonly owner: ArenaTournamentFrames.Owner;

    constructor(room: GroupRef, owner: ArenaTournamentFrames.Owner) {
        this.room = room;
        this.owner = owner;
    }

    subscribe(browser: SubscribeViewRecovery.Browser, run: () => Promise<void>): () => void {
        const subscriptions = new SubscriptionScope();
        subscriptions.add(browser.messages.ws.onMessage(
            { topicId: ARENA_TOURNAMENT_SNAPSHOT_TOPIC },
            (message) => this.receive(message, this.owner.attempt())
        ));
        subscriptions.add(browser.ws.onLifecycle((event) => {
            if (event.kind === 'close' || event.kind === 'disconnected' || event.kind === 'open') {
                this.discard();
            }
        }, { emitCurrent: false }));
        subscriptions.add(subscribeViewInvalidations({
            browser,
            scope: this.room,
            resource: 'tournament',
            changed: () => {
                void run();
            }
        }));
        return () => subscriptions.unsubscribe();
    }

    authorize(attempt: AuthenticatedResource.ReadInput): void {
        this.authorizedRead = attempt;
        if (this.trailingFrame && !this.decoding) {
            queueMicrotask(() => this.resumeFrame());
        }
    }

    discard(): void {
        this.streamGeneration++;
        this.trailingFrame = null;
    }

    async receive(
        message: RallarMessage<ApiJsonValue>,
        attempt: AuthenticatedResource.ReadInput | null
    ): Promise<void> {
        if (
            !attempt || !this.owner.current(attempt) || message.transport !== 'ws' ||
            !this.owner.isActive()
        ) {
            return;
        }
        const { raw } = message;
        if (!isArenaTournamentRoomFrame(raw, this.room)) {
            return;
        }
        let header;
        try {
            header = decodeArenaTournamentFrameHeader(message.payload);
        }
        catch {
            return;
        }
        const anchor = this.owner.snapshot();
        if (
            anchor &&
            (header.attemptId !== anchor.binding.attemptId || header.attemptRevision <= anchor.attemptRevision ||
                !isArenaTournamentFrameMessage(raw, anchor.binding))
        ) {
            return;
        }
        const frame = {
            message,
            attempt,
            generation: this.streamGeneration,
            attemptId: header.attemptId,
            attemptRevision: header.attemptRevision
        };
        if (this.decoding || anchor === undefined) {
            const pending = this.trailingFrame;
            if (
                !pending || !this.owner.current(pending.attempt) || pending.attemptId !== frame.attemptId ||
                pending.attemptRevision < frame.attemptRevision
            ) {
                this.trailingFrame = frame;
            }
            return;
        }
        await this.decodeFrame(frame);
    }

    private resumeFrame(): void {
        if (this.decoding) {
            return;
        }
        const trailing = this.trailingFrame;
        this.trailingFrame = null;
        if (trailing) {
            void this.decodeFrame(trailing);
        }
    }

    private async decodeFrame({ message, attempt, generation }: ArenaTournamentFrames.CapturedFrame): Promise<void> {
        const anchor = this.owner.snapshot();
        if (
            !anchor || !this.authorizedRead || !this.owner.current(this.authorizedRead) ||
            !this.owner.current(attempt) ||
            generation !== this.streamGeneration || !this.owner.isActive() ||
            !isArenaTournamentFrameMessage(message.raw, anchor.binding)
        ) {
            return;
        }
        this.decoding = true;
        try {
            const next = await decodeArenaTournamentFrame(message.payload);
            const current = this.owner.snapshot();
            if (
                generation === this.streamGeneration && current && jsonEquals(current.binding, next.binding) &&
                next.attemptRevision > current.attemptRevision &&
                (current.status === 'scheduled' || current.status === 'playing')
            ) {
                this.owner.publish(attempt, next);
            }
        }
        catch {
            // Malformed volatile frames never establish authority. The next full frame is independent.
        }
        finally {
            this.decoding = false;
            this.resumeFrame();
        }
    }
}
