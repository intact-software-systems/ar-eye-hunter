import { onTestFinished } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALPersistedInboundEffect } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundAdmittedDelivery } from '@shared/alm/inbound/al-inbound-admitted-delivery.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { decodeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';

import {
    INBOUND_TEST_EFFECT_PREPARATION,
    planInboundTestMessage,
    readInboundTestAdmission
} from './inbound-runtime-test-fixture.ts';

export interface InboundTestDispatch {
    readonly delivery: ALInboundAdmittedDelivery;
    /** One message id per dispatch, so a delivery that never reached the page reads as an empty list. */
    readonly dispatched: readonly string[];
}

/**
 * The admitted delivery the runtime composes, over the caller's own stores and on the caller's own
 * clock, so a pin can drive one row from its readiness read through its dispatch without a rotation
 * around it.
 */
export function createInboundTestDispatch(
    stores: ALInboundRuntimeStores,
    nowMs: () => number
): InboundTestDispatch {
    const dispatched: string[] = [];
    const delivery = new ALInboundAdmittedDelivery({
        admissionStore: stores.admissionStore,
        planIncomingMessage: planInboundTestMessage,
        dispatchInboxEntry: async (entry) => {
            dispatched.push(decodePersistedALMessage(entry.resource).id.msgId);
        },
        sendControlMessage: async () => {},
        clock: { nowMs },
        effectPreparation: INBOUND_TEST_EFFECT_PREPARATION
    });
    onTestFinished(() => delivery.dispose());
    return { delivery, dispatched };
}

/** Commits one message's real admission and returns the `dispatch-local` row it left behind. */
export async function readInboundTestDispatchEffect(
    stores: ALInboundRuntimeStores,
    msg: ALMessage
): Promise<ALPersistedInboundEffect> {
    const { admissionStore, workQueue } = stores;
    const committed = await admissionStore.commitBundle(await readInboundTestAdmission(admissionStore, msg));
    if (committed !== 'committed') {
        throw new Error(`The admission of ${msg.id.msgId} left no committed work: ${committed}`);
    }
    for (const key of await workQueue.getAllKeys()) {
        const entry = await workQueue.getItem(key);
        if (entry === undefined) {
            continue;
        }
        const effect = decodeALInboundWorkEntry(entry, admissionStore.namespace);
        if (effect.payload.kind === 'dispatch-local' && effect.payload.message.msgId === msg.id.msgId) {
            return effect;
        }
    }
    throw new Error(`The admission of ${msg.id.msgId} wrote no dispatch-local row`);
}
