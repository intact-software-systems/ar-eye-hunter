import { toKeyAsString, type Key, type ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import type { ALAdmissionBackendEntry } from '../../al-admission-backend.ts';
import type { ALAdmissionDecoder } from '../../al-admission-decoder.ts';
import type { ALAdmissionReadSession } from '../../al-admission-work-backend.ts';

/**
 * The read session of one single-send decision. A work row it already read answers again from that
 * read, so the observation its commit fences re-reads nothing the decision surface holds; the write
 * re-reads every observed row inside its fence, so a held row is never trusted past that fence.
 */
export class ALOutboundDecisionReadSession implements ALAdmissionReadSession {
    readonly #session: ALAdmissionReadSession;
    readonly #workReads = new Map<string, Promise<ResourceEntry | undefined>>();

    constructor(session: ALAdmissionReadSession) {
        this.#session = session;
    }

    read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        return this.#session.read(key, decode);
    }

    list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        return this.#session.list(prefix, decode);
    }

    readWork(key: Key): Promise<ResourceEntry | undefined> {
        const keyString = toKeyAsString(key);
        const held = this.#workReads.get(keyString) ?? this.#session.readWork(key);
        this.#workReads.set(keyString, held);
        return held;
    }
}
