import { describe, expect, it, vi } from 'vitest';

import { AppInboxHandlerRegistry } from '@shared-server/rallar-system/app-inbox/app-inbox-handler-registry.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import { GROUP_MUTATION_INBOX_TYPES } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { RtcRttInboxService } from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-inbox-service.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';

import { createAuthorityHarness } from './group-state-inbox-test-runtime.ts';

describe('domain AppInbox registration', () => {
    it('registers every group, topology, and RTC-RTT handler during construction', async () => {
        const registration = vi
            .spyOn(AppInboxHandlerRegistry.prototype, 'onStateMessage')
            .mockImplementation(() => undefined);
        try {
            const harness = await createAuthorityHarness(['owner']);
            new TopologyInboxService(
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
            new RtcRttInboxService(
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

            expect(registration.mock.calls.map(([type]) => type)).toEqual([
                ...GROUP_MUTATION_INBOX_TYPES.filter(
                    (type) => type !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP
                ),
                AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
                AppInboxType.TOPOLOGY_CONFIG_PUT,
                AppInboxType.TOPOLOGY_CONFIG_DELETE,
                AppInboxType.TOPOLOGY_OVERRIDE_PUT,
                AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
                AppInboxType.TOPOLOGY_RECONFIGURE,
                AppInboxType.RTC_RTT_SUBMIT
            ]);
        }
        finally {
            registration.mockRestore();
        }
    });
});
