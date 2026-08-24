import { describe, expect, it } from 'vitest';

import { RtcRttInboxService } from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-inbox-service.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';

import { createAuthorityHarness } from './group-state-inbox-test-runtime.ts';

describe('domain AppInbox registration', () => {
    it('finishes construction only after group, topology, and RTC-RTT registration', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const topology = new TopologyInboxService(
            {
                inboxQueueReader: harness.reader,
                resourceInboxRepository: harness.queue,
                resourceInboxResultsRepository: harness.results,
                database: harness.database,
                groupStateService: harness.groupStateService,
                mutationOwners: {
                    configMutationService: {} as never,
                    reconfigureMutation: {} as never
                }
            },
            { serviceId: 'server-12345678' }
        );
        const rtcRtt = new RtcRttInboxService(
            {
                inboxQueueReader: harness.reader,
                resourceInboxRepository: harness.queue,
                resourceInboxResultsRepository: harness.results,
                database: harness.database,
                groupStateService: harness.groupStateService,
                mutationDependencies: {} as never
            },
            { serviceId: 'server-12345678' }
        );

        expect(topology).toBeInstanceOf(TopologyInboxService);
        expect(rtcRtt).toBeInstanceOf(RtcRttInboxService);
    });
});
