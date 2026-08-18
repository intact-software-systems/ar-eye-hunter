import { describe, expect, it, type Mock, vi } from 'vitest';

import type { AppInboxMessageContext } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
  AppInboxService,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/topology/group-topology-management-service.ts';
import { GroupTopologyConfigMutationService } from '@shared-server/rallar-system/topology/config/group-topology-config-mutation-service.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { GroupTopologyReconfigureMutation } from '@shared-server/rallar-system/topology/reconfigure/group-topology-reconfigure-mutation.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import type { TopologyAppInboxMutationOwners } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';
import type { RtcRttAppInboxDependencies } from '@shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-contracts.ts';
import { GROUP_MUTATION_INBOX_TYPES } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';

import { createAuthorityHarness } from './group-state-inbox-test-runtime.ts';

describe('AppGroupInboxService registration lifecycle', () => {
  it('keeps same-identity setter calls idempotent and distinct values rejected', async () => {
    const harness = await createAuthorityHarness(['owner']);
    const firstTopology = createTopologyManagement(harness);
    const secondTopology = createTopologyManagement(harness);
    const firstRttDependencies = {} as never;
    const secondRttDependencies = {} as never;

    expect(() => {
      harness.service.setTopologyManagementService(firstTopology);
      harness.service.setTopologyManagementService(firstTopology);
    }).not.toThrow();
    expect(() => harness.service.setTopologyManagementService(secondTopology)).toThrow(
      'Topology management service is already configured',
    );
    expect(() => {
      harness.service.setRtcRttAppInboxDependencies(firstRttDependencies);
      harness.service.setRtcRttAppInboxDependencies(firstRttDependencies);
    }).not.toThrow();
    expect(() => harness.service.setRtcRttAppInboxDependencies(secondRttDependencies)).toThrow(
      'RTC RTT AppInbox dependencies are already configured',
    );
  });

  it('rejects topology registration when either canonical mutation owner is absent', async () => {
    const harness = await createAuthorityHarness(['owner']);
    const incomplete = new GroupTopologyManagementService({
      findGroupSnapshotByRef: (ref) => harness.repository.readSnapshot(ref),
      topologyService: new RallarRtcTopologyService(),
    });

    expect(incomplete.configMutationService).toBeUndefined();
    expect(incomplete.reconfigureMutation).toBeUndefined();
    expect(() => harness.service.setTopologyManagementService(incomplete)).toThrow(
      'Topology AppInbox mutations require config and reconfigure owners',
    );
  });
  it('registers group callbacks first and each deferred family exactly once', async () => {
    const registration = vi
      .spyOn(AppInboxService.prototype, 'onStateMessage')
      .mockImplementation(() => undefined);
    try {
      const harness = await createAuthorityHarness(['owner']);
      const topology = createTopologyManagement(harness);
      const rtc = {} as RtcRttAppInboxDependencies;

      expect(registeredTypes(registration)).toEqual(groupRegistrationOrder());
      harness.service.setTopologyManagementService(topology);
      harness.service.setTopologyManagementService(topology);
      harness.service.setRtcRttAppInboxDependencies(rtc);
      harness.service.setRtcRttAppInboxDependencies(rtc);

      expect(registeredTypes(registration)).toEqual([
        ...groupRegistrationOrder(),
        ...TOPOLOGY_REGISTRATION_ORDER,
        AppInboxType.RTC_RTT_SUBMIT,
      ]);
    } finally {
      registration.mockRestore();
    }
  });

  it('captures the exact complete dependency instead of reading mutable facade state', async () => {
    const registration = vi
      .spyOn(AppInboxService.prototype, 'onStateMessage')
      .mockImplementation(() => undefined);
    try {
      const harness = await createAuthorityHarness(['owner']);
      await assertCapturedDependencies(harness.service, registration);
    } finally {
      registration.mockRestore();
    }
  });

  it('exposes the canonical mutation owners directly and keeps facade delegation one-way', async () => {
    const harness = await createAuthorityHarness(['owner']);
    const topology = createTopologyManagement(harness);

    expect(topology.configMutationService).toBeInstanceOf(GroupTopologyConfigMutationService);
    expect(topology.reconfigureMutation).toBeInstanceOf(GroupTopologyReconfigureMutation);
    const ownerRead = vi
      .spyOn(topology.configMutationService!, 'read')
      .mockResolvedValue({} as never);

    await topology.readTopologyConfigMutation({} as never);

    expect(ownerRead).toHaveBeenCalledOnce();
  });
});

const TOPOLOGY_REGISTRATION_ORDER = [
  AppInboxType.TOPOLOGY_CONFIG_PUT,
  AppInboxType.TOPOLOGY_CONFIG_DELETE,
  AppInboxType.TOPOLOGY_OVERRIDE_PUT,
  AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
  AppInboxType.TOPOLOGY_RECONFIGURE,
] as const;

type RegistrationSpy = Mock<AppInboxService['onStateMessage']>;

function groupRegistrationOrder(): readonly AppInboxType[] {
  return [
    ...GROUP_MUTATION_INBOX_TYPES.filter(
      (type) => type !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
    ),
    AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
  ];
}

function registeredTypes(registration: RegistrationSpy): readonly AppInboxType[] {
  return registration.mock.calls.map(([type]) => type);
}

async function assertCapturedDependencies(
  service: Awaited<ReturnType<typeof createAuthorityHarness>>['service'],
  registration: RegistrationSpy,
): Promise<void> {
  const topology = {
    configMutationService: {},
    reconfigureMutation: {},
  } as GroupTopologyManagementService;
  const rtc = {} as RtcRttAppInboxDependencies;
  const internals = service as unknown as DeferredHandlerInternals;
  const topologyProcess = vi
    .spyOn(internals.topologyAppInboxHandler, 'processMutation')
    .mockResolvedValue({} as never);
  const rtcProcess = vi
    .spyOn(internals.rtcRttAppInboxHandler, 'processMutation')
    .mockResolvedValue({} as never);

  service.setTopologyManagementService(topology);
  service.setRtcRttAppInboxDependencies(rtc);
  internals.topologyManagementService = undefined;
  internals.rtcRttDependencies = undefined;
  const context = {} as AppInboxMessageContext;
  await readHandler(registration, AppInboxType.TOPOLOGY_CONFIG_PUT)(undefined, context);
  await readHandler(registration, AppInboxType.RTC_RTT_SUBMIT)(undefined, context);

  expect(topologyProcess).toHaveBeenCalledWith(context, {
    configMutationService: topology.configMutationService,
    reconfigureMutation: topology.reconfigureMutation,
  });
  expect(rtcProcess).toHaveBeenCalledWith(context, rtc);
}

function createTopologyManagement(
  harness: Awaited<ReturnType<typeof createAuthorityHarness>>,
): GroupTopologyManagementService {
  return new GroupTopologyManagementService({
    findGroupSnapshotByRef: (ref) => harness.repository.readSnapshot(ref),
    groupStateRepository: harness.repository,
    configRepository: new GroupTopologyConfigRepository(harness.runtimeRepository),
    topologyService: new RallarRtcTopologyService(),
  });
}

function readHandler(registration: RegistrationSpy, type: AppInboxType) {
  const call = registration.mock.calls.find(([registeredType]) => registeredType === type);
  if (!call) throw new Error(`Expected ${type} registration`);
  return call[1];
}

interface DeferredHandlerInternals {
  topologyManagementService?: GroupTopologyManagementService;
  rtcRttDependencies?: RtcRttAppInboxDependencies;
  readonly topologyAppInboxHandler: {
    processMutation(
      context: AppInboxMessageContext,
      owners: TopologyAppInboxMutationOwners,
    ): Promise<unknown>;
  };
  readonly rtcRttAppInboxHandler: {
    processMutation(
      context: AppInboxMessageContext,
      dependencies: RtcRttAppInboxDependencies,
    ): Promise<unknown>;
  };
}
