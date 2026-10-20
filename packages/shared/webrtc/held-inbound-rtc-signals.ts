import type { ALMessage } from '../al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs } from '../al-contracts/al-policy.ts';
import { LatestRepository } from '../cache/LatestRepository.ts';
import { toError } from '../resilience/to-error.ts';
import type { QRtcSignalingMessage } from './qrtc-signaling-contracts.ts';

/** Past this many held signals the oldest is forgotten; it still arrives on its own retry schedule. */
export const MAX_HELD_INBOUND_RTC_SIGNALS = 256;

export namespace HeldInboundRtcSignals {
    /** A signal the inbound creation policy answered `retry` for, with the reason it gave. */
    export interface Held {
        readonly envelope: ALMessage;
        readonly signal: QRtcSignalingMessage;
        readonly reason: string;
    }

    export interface Dependencies {
        readonly nowEpochMs: () => number;
        /** Answers the envelopes whose retained delivery it brought due; a row claimed meanwhile is not among them. */
        readonly writeRetainedSignalsDueNow: (envelopes: readonly ALMessage[]) => Promise<readonly ALMessage[]>;
    }
}

/**
 * The inbound signals that wait out a retry their creation policy asked for, so a change that clears
 * the reason can bring them due at once. Each lives until the transport delivers it again, its own
 * deadline passes, or newer holds push it past the cap.
 */
export class HeldInboundRtcSignals {
    private readonly held = new LatestRepository<string, HeldInboundRtcSignals.Held>({
        maxEntries: MAX_HELD_INBOUND_RTC_SIGNALS
    });
    private readonly dependencies: HeldInboundRtcSignals.Dependencies;

    constructor(dependencies: HeldInboundRtcSignals.Dependencies) {
        this.dependencies = dependencies;
    }

    hold(held: HeldInboundRtcSignals.Held): void {
        this.held.acceptAt({
            key: toHeldInboundSignalKey(held.envelope),
            value: held,
            nowEpochMs: this.dependencies.nowEpochMs(),
            expireAtEpochMs: resolveALMessageExpireAtMs(held.envelope)
        });
    }

    /** A delivery of `envelope` decides it again, so a hold for it is moot until that delivery holds it anew. */
    forget(envelope: ALMessage): void {
        this.held.delete(toHeldInboundSignalKey(envelope));
    }

    /**
     * Brings the signals held for `reason` that `isAdmittedNow` admits due at once instead of after
     * their retry delay; the delivery still decides each one. Holds of another reason, still refused,
     * or whose row the transport did not bring due wait for their own retry.
     */
    async writeDueNow(reason: string, isAdmittedNow: (signal: QRtcSignalingMessage) => boolean): Promise<void> {
        const heldKeys = [...this.held.entriesView()]
            .filter(([, held]) => held.peek()?.reason === reason)
            .map(([key]) => key);
        if (heldKeys.length === 0) {
            return;
        }
        const nowEpochMs = this.dependencies.nowEpochMs();
        const admitted = new Map<string, HeldInboundRtcSignals.Held>();
        for (const key of heldKeys) {
            const held = this.held.readAt(key, nowEpochMs);
            if (held !== undefined && isAdmittedNow(held.signal)) {
                admitted.set(key, held);
            }
        }
        if (admitted.size === 0) {
            return;
        }
        for (const envelope of await this.writeAdmittedDueNow([...admitted.values()])) {
            const key = toHeldInboundSignalKey(envelope);
            const written = admitted.get(key);
            if (written !== undefined && this.held.peek(key) === written) {
                this.held.delete(key);
            }
        }
    }

    private async writeAdmittedDueNow(
        admitted: readonly HeldInboundRtcSignals.Held[]
    ): Promise<readonly ALMessage[]> {
        try {
            return await this.dependencies.writeRetainedSignalsDueNow(admitted.map((held) => held.envelope));
        }
        catch (caught) {
            console.error('Failed to bring held inbound RTC signals due', toError(caught));
            return [];
        }
    }
}

/** A message id is unique per sender only, so a hold is keyed by both, as ALM keys its own rows. */
function toHeldInboundSignalKey(envelope: ALMessage): string {
    return JSON.stringify([envelope.id.senderId, envelope.id.msgId]);
}
