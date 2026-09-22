import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALDeliveryAdmissionVerdict, ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
export interface MessageDeliveryFixture {
    readonly handle: RallarMessageHandle;
    readonly registry: BrowserRallarDeliveryRegistry;
}

let messageSequence = 0;

export function createMessageDelivery(
    carrier: ALDeliveryCarrier,
    verdict: ALDeliveryAdmissionVerdict | undefined
): MessageDeliveryFixture {
    const registry = new BrowserRallarDeliveryRegistry({ nowMs: Date.now, retainTerminalMs: 60_000, maxEntries: 1, cancel: () => {} });
    const handle = registry.open({
        id: { v: 2, msgId: `test-message-${++messageSequence}`, ts: Date.now(), senderId: 'client-1' },
        route: { topicId: 'test', contextId: 'test', resourceId: 'test' },
        payload: { typeId: 'test', contentType: 'application/json', resource: '{}' }
    }, carrier);
    if (verdict) {
        registry.record({ kind: 'admission', msgId: handle.msgId, carrier, atMs: Date.now(), verdict });
    }
    return { handle, registry };
}
