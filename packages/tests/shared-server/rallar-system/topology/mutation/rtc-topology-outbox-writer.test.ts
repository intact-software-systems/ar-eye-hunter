import { describe, expect, it } from 'vitest';

import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';

describe('RTC topology outbox committed-write observer', () => {
    it('records the exact committed count for its own observer', () => {
        const observations = { first: 0, second: 0 };
        const firstWriter = new RtcTopologyOutboxWriter({
            recordWrite: () => {
                observations.first += 1;
            }
        });
        const secondWriter = new RtcTopologyOutboxWriter({
            recordWrite: () => {
                observations.second += 1;
            }
        });

        firstWriter.recordCommitted(2);
        secondWriter.recordCommitted();

        expect(observations).toEqual({ first: 2, second: 1 });
    });

    it('does not let observability failures alter a committed mutation', () => {
        const writer = new RtcTopologyOutboxWriter({
            recordWrite: () => {
                throw new Error('observer failed');
            }
        });

        expect(() => writer.recordCommitted()).not.toThrow();
    });
});
