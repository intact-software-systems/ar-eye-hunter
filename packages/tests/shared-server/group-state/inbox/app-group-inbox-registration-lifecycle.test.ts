import { describe, expect, it, vi } from 'vitest';

import type { AppInboxMessageContext } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
  AppInboxService,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/topology/group-topology-management-service.ts';
import type { TopologyAppInboxMutationOwners } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';
import type { RtcRttAppInboxDependencies } from '@shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-contracts.ts';
import { GROUP_MUTATION_INBOX_TYPES } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';

import { createAuthorityHarness } from './group-state-inbox-test-runtime.ts';

describe('AppGroupInboxService registration lifecycle', () => {
  it('keeps same-identity setter calls idempotent and distinct values rejected', async () => {
    const harness = await createAuthorityHarness(['owner']);
    const firstTopology = {} as never;
    const secondTopology = {} as never;
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

  it('registers group callbacks first and each deferred family exactly once', async () => {
    const registration = vi
      .spyOn(AppInboxService.prototype, 'onStateMessage')
      .mockImplementation(() => undefined);
    try {
      const harness = await createAuthorityHarness(['owner']);
      const topology = {} as GroupTopologyManagementService;
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

  it('preserves facade virtual dispatch through the captured narrow capabilities', async () => {
    const topology = new GroupTopologyManagementService({} as never);
    const facadeRead = vi
      .spyOn(topology, 'readTopologyConfigMutation')
      .mockResolvedValue({} as never);

    await topology.configMutationService.read({} as never);

    expect(facadeRead).toHaveBeenCalledOnce();
  });
});

const TOPOLOGY_REGISTRATION_ORDER = [
  AppInboxType.TOPOLOGY_CONFIG_PUT,
  AppInboxType.TOPOLOGY_CONFIG_DELETE,
  AppInboxType.TOPOLOGY_OVERRIDE_PUT,
  AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
  AppInboxType.TOPOLOGY_RECONFIGURE,
] as const;

type RegistrationSpy = ReturnType<typeof vi.spyOn<AppInboxService, 'onStateMessage'>>;

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
    writeConfigMutation: expect.any(Function),
    toConfigMutationResult: expect.any(Function),
  });
  expect(rtcProcess).toHaveBeenCalledWith(context, rtc);
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
