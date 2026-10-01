import { LatestRepository } from '../../../cache/LatestRepository.ts';
import { toKeyAsString, type Key, type ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import type { ALOutboundCommitBundle } from '../admission/al-outbound-admission-store.ts';
import { AL_OUTBOUND_WORK_PAGE_SIZE, toALOutboundWorkKey } from '../al-outbound-work-entry.ts';

/** Four work pages: what the commits between two claiming batches of one lane can hand over. */
export const AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT = 4 * AL_OUTBOUND_WORK_PAGE_SIZE;

export namespace ALOutboundCanonicalHandoff {
    export interface Input {
        readonly namespace: string;
        readonly limit: number;
    }
}

/**
 * The canonical row a commit of one lane wrote, held for the claim of each prepared send that
 * references it so that claim need not read it back. A cache of an immutable row, never a source:
 * a claim that finds nothing here reads storage.
 */
export class ALOutboundCanonicalHandoff {
    private readonly namespace: string;
    private readonly canonicalByWorkKey: LatestRepository<string, ResourceEntry>;

    constructor(input: ALOutboundCanonicalHandoff.Input) {
        this.namespace = input.namespace;
        this.canonicalByWorkKey = new LatestRepository({ maxEntries: input.limit });
    }

    /**
     * Holds a committed bundle's canonical row for each prepared send it wrote, until that send's
     * deadline; past the limit the oldest go.
     */
    setCommitted<TPrepared>(bundle: ALOutboundCommitBundle<TPrepared>, nowMs: number): void {
        const canonical = bundle.canonicalEntry;
        if (canonical === undefined) {
            return;
        }
        for (const effect of bundle.durableEffects) {
            if (effect.payload.kind === 'send-prepared') {
                const workKey = toKeyAsString(toALOutboundWorkKey(this.namespace, effect.effectId));
                this.canonicalByWorkKey.delete(workKey);
                this.canonicalByWorkKey.acceptAt({
                    key: workKey,
                    value: canonical,
                    nowEpochMs: nowMs,
                    expireAtEpochMs: effect.payload.message.expiresAtMs
                });
            }
        }
    }

    /** The live row held for one claimed work slot, given up as it is handed over: a retried claim reads storage. */
    takeCanonical(workKey: Key, nowMs: number): ResourceEntry | undefined {
        const keyString = toKeyAsString(workKey);
        const canonical = this.canonicalByWorkKey.readAt(keyString, nowMs);
        this.canonicalByWorkKey.delete(keyString);
        return canonical;
    }

    clear(): void {
        this.canonicalByWorkKey.clearAll();
    }
}
