import { isRtcTopologyPublicationOutboxEntry } from '@shared-server/rallar-system/topology/replay/is-rtc-topology-publication-outbox-entry.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { describe, expect, it } from 'vitest';

import { createRtcTopologyReplayFixture } from './rtc-topology-replay-fixture.ts';

describe('RTC topology replay wake validation', () => {
    it('accepts only the strict fixed-audience topology publication outbox shape', () => {
        const fixture = createRtcTopologyReplayFixture();
        const otherOutbox = QueueBoxUtilities.toResourceEntryFromMsg(
            newALBroadcastMessage(
                'rallar-server',
                newALRoute('app.other', 'all', 'other-1'),
                'all',
                'app.other.v1',
                { value: true }
            ),
            WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE
        );

        expect(isRtcTopologyPublicationOutboxEntry(fixture.outbox)).toBe(true);
        expect(isRtcTopologyPublicationOutboxEntry(otherOutbox)).toBe(false);
        expect(
            isRtcTopologyPublicationOutboxEntry({
                ...fixture.outbox,
                resource: JSON.stringify({ not: 'an AL message' })
            })
        ).toBe(false);
    });
});
