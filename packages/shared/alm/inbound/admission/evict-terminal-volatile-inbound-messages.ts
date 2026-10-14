import type { ALPendingAckSnapshot } from '../../../al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '../../../al-contracts/al-runtime.ts';
import { EntityStatus, toKeyAsString } from '../../../queuebox/ResourceEntry.ts';
import {
    decodeALAdmissionStoredValue,
    type ALAdmissionStoredValue,
    type InMemoryAdmissionBackend
} from '../../al-admission-backend.ts';
import { ALAdmissionCorruptionError, decodeALAdmissionValue } from '../../al-admission-decoder.ts';
import {
    decodeALAdmissionControlValue,
    decodeALAdmissionNumber,
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../../al-admission-value-validation.ts';
import {
    decodeALStoredInboundMessage,
    toALInboundMessageKey,
    type ALStoredInboundMessage
} from '../al-inbound-canonical-message.ts';
import {
    decodeALInboundBufferedSnapshot,
    type ALStoredInboundBufferedSnapshot
} from '../al-inbound-ordering-validation.ts';
import {
    decodeALInboundWorkEntry,
    toALInboundWorkKey,
    type ALPersistedInboundEffect
} from '../al-inbound-work-entry.ts';
import { toALInboundControlPendingKey } from '../control/al-inbound-control-rows.ts';
import { toALPendingAckOwedPeerIds } from './compute-al-inbound-duplicate-changes.ts';

interface HeldCanonical {
    readonly key: string;
    readonly row: ALAdmissionStoredValue;
    readonly message: ALStoredInboundMessage;
}

interface HeldBuffered {
    readonly key: string;
    readonly snapshot: ALStoredInboundBufferedSnapshot;
}

interface HeldPending {
    readonly key: string;
    readonly messageKey: string;
    readonly snapshot: ALPendingAckSnapshot;
}

interface HeldInboundRows {
    readonly canonical: readonly HeldCanonical[];
    readonly buffered: readonly HeldBuffered[];
    readonly pending: readonly HeldPending[];
}

/** The volatile pair alone runs this after its ordinary expiry sweep. No retained fact is changed. */
export function evictTerminalVolatileInboundMessages(backend: InMemoryAdmissionBackend, namespace: string): void {
    const rows = readHeldInboundRows(backend, namespace);
    const work = readHeldInboundWork(backend, namespace);
    const reclaimable = selectReclaimableEnvelopes(rows, work, namespace);
    for (const message of reclaimable) {
        backend.removeObservedIfNoWrites(message.key, message.row);
    }
}

function readHeldInboundRows(backend: InMemoryAdmissionBackend, namespace: string): HeldInboundRows {
    const canonical: HeldCanonical[] = [];
    const buffered: HeldBuffered[] = [];
    const pending: HeldPending[] = [];
    for (const key of backend.peekKeys()) {
        if (!key.startsWith(`${namespace}:`)) {
            continue;
        }
        const raw = backend.peek(key);
        if (raw === undefined) {
            throw new ALAdmissionCorruptionError(key, new TypeError('Admission row changed during maintenance'));
        }
        const row = decodeALAdmissionValue(raw, key, decodeALAdmissionStoredValue);
        if (key.startsWith(`${namespace}:message:`)) {
            canonical.push(readCanonical(raw, row, namespace));
        }
        else if (key.startsWith(`${namespace}:buffered:`)) {
            buffered.push({ key, snapshot: readBuffered(key, row, namespace) });
        }
        else if (key.startsWith(`${namespace}:control:pending:`)) {
            pending.push(readPending(key, row, namespace));
        }
        else if (!isKnownOtherInboundKey(key, namespace)) {
            throw new ALAdmissionCorruptionError(key, new TypeError('Unknown volatile inbound admission row'));
        }
    }
    return { canonical, buffered, pending };
}

function readCanonical(raw: ALAdmissionStoredValue, row: ALAdmissionStoredValue, namespace: string): HeldCanonical {
    const { key } = row;
    const message = decodeALAdmissionValue(row.value, key, (value) => {
        const record = decodeALAdmissionRecord(value, ['msgId', 'senderId', 'msg', 'retainUntilMs']);
        const reference = {
            senderId: decodeALAdmissionString(record.senderId),
            msgId: decodeALAdmissionString(record.msgId)
        };
        return decodeALStoredInboundMessage(value, { namespace, key, reference });
    });
    if (message.retainUntilMs !== row.expireAtTimestamp) {
        throw new ALAdmissionCorruptionError(key, new TypeError('Canonical envelope expiry differs from its row'));
    }
    return { key, row: raw, message };
}

function readBuffered(key: string, row: ALAdmissionStoredValue, namespace: string): ALStoredInboundBufferedSnapshot {
    return decodeALAdmissionValue(row.value, key, (value) => {
        const record = decodeALAdmissionRecord(value, ['trackKey', 'seq', 'message', 'plan', 'carrier'], ['delivery']);
        const trackKey = decodeALAdmissionString(record.trackKey);
        const seq = decodeALAdmissionNumber(record.seq);
        const prefix = `${namespace}:buffered:${trackKey}:`;
        if (key !== `${prefix}${seq}`) {
            throw new TypeError('Buffered slot key differs from its track and sequence');
        }
        return decodeALInboundBufferedSnapshot(value, { trackKey, prefix, key });
    });
}

function readPending(key: string, row: ALAdmissionStoredValue, namespace: string): HeldPending {
    return decodeALAdmissionValue(row.value, key, (value) => {
        const parts = key.slice(`${namespace}:control:pending:`.length).split(':');
        if (parts.length !== 2) {
            throw new TypeError('Pending control key has no unique message owner');
        }
        const msgId = decodeALAdmissionString(decodeURIComponent(parts[0]));
        const senderId = decodeALAdmissionString(decodeURIComponent(parts[1]));
        if (key !== toALInboundControlPendingKey(namespace, msgId, senderId)) {
            throw new TypeError('Pending control key is not canonical');
        }
        return {
            key,
            messageKey: toALInboundMessageKey(namespace, { msgId, senderId }),
            snapshot: decodeALAdmissionControlValue(value, msgId, 'pending').value
        };
    });
}

function readHeldInboundWork(
    backend: InMemoryAdmissionBackend,
    namespace: string
): readonly ALPersistedInboundEffect[] {
    const prefix = toKeyAsString(toALInboundWorkKey(namespace, ''));
    const work: ALPersistedInboundEffect[] = [];
    for (const key of backend.workQueue.peekKeys()) {
        if (!key.startsWith(prefix)) {
            continue;
        }
        const entry = backend.workQueue.peek(key);
        if (entry === undefined) {
            throw new ALAdmissionCorruptionError(key, new TypeError('Inbound work changed during maintenance'));
        }
        work.push(decodeALInboundWorkEntry(entry, namespace));
    }
    return work;
}

/** Complete and pure: one invalid dependency prevents every removal in this maintenance turn. */
function selectReclaimableEnvelopes(
    rows: HeldInboundRows,
    work: readonly ALPersistedInboundEffect[],
    namespace: string
): readonly HeldCanonical[] {
    const canonical = new Map(rows.canonical.map((message) => [message.key, message]));
    const required = new Set<string>();
    for (const buffered of rows.buffered) {
        const key = toALInboundMessageKey(namespace, buffered.snapshot.message);
        const owner = requireCanonical(canonical, key, buffered.key).message;
        if (
            toALOrderingTrackKey(owner.msg) !== buffered.snapshot.trackKey ||
            owner.msg.ordering?.seq !== buffered.snapshot.seq
        ) {
            throw new ALAdmissionCorruptionError(buffered.key, new TypeError('Buffered owner differs from its slot'));
        }
        required.add(key);
    }
    for (const pending of rows.pending) {
        if (toALPendingAckOwedPeerIds(pending.snapshot).length > 0) {
            requireCanonical(canonical, pending.messageKey, pending.key);
            required.add(pending.messageKey);
        }
    }
    for (const effect of work) {
        if (effect.entry.status === EntityStatus.COMPLETED) {
            continue;
        }
        if (effect.payload.kind === 'dispatch-local' || effect.payload.kind === 'forward-message') {
            const key = toALInboundMessageKey(namespace, effect.payload.message);
            requireCanonical(canonical, key, toKeyAsString(effect.entry.key));
            required.add(key);
        }
    }
    return rows.canonical.filter((message) => !required.has(message.key));
}

function requireCanonical(canonical: Map<string, HeldCanonical>, key: string, dependentKey: string): HeldCanonical {
    const owner = canonical.get(key);
    if (owner === undefined) {
        throw new ALAdmissionCorruptionError(
            dependentKey,
            new TypeError('Inbound dependency has no canonical envelope')
        );
    }
    return owner;
}

function isKnownOtherInboundKey(key: string, namespace: string): boolean {
    return [
        'msg-owner:',
        'dedup:',
        'claim:',
        'ordering:',
        'supersedence:',
        'delivered:',
        'control:acks:',
        'control:owners:'
    ].some((part) => key.startsWith(`${namespace}:${part}`));
}
