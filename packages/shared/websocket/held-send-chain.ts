import { ExclusionKeyedAdmission } from '../resilience/exclusion-keyed-admission.ts';
import type { ExpectedConnectionHolds } from './expected-connection-holds.ts';

export namespace HeldSendChain {
    export interface AudienceSend {
        readonly expiresAtEpochMs: number;
        /** Re-checks and sends one awaited session's copy, once its socket opens or its upgrade settles. */
        readonly send: (sessionId: string) => Promise<unknown>;
    }
}

/** One owner's held sends: a session's sends run one after the other in hold order; a failed one is logged and releases the next. */
export class HeldSendChain {
    readonly #chains = new ExclusionKeyedAdmission({ maxConcurrent: Number.MAX_SAFE_INTEGER, keyedChainsFirst: false });

    holdForAudience(
        holds: Pick<ExpectedConnectionHolds, 'holdForAudience'>,
        audience: readonly string[],
        audienceSend: HeldSendChain.AudienceSend
    ): ExpectedConnectionHolds.AudienceHold {
        return holds.holdForAudience(audience, {
            expiresAtEpochMs: audienceSend.expiresAtEpochMs,
            send: (sessionId) => {
                void this.#chains.admit(sessionId, () => audienceSend.send(sessionId))
                    .catch((error) => console.error('Held WebSocket send failed:', error));
            }
        });
    }
}
