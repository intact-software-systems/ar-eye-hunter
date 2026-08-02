import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createAuthorityHarness } from './group-state-inbox-test-runtime.ts';

const servicePath = 'packages/shared-server/rallar-system/services/AppGroupInboxService.ts';

describe('AppGroupInboxService registration lifecycle', () => {
  it('characterizes predecessor setters and live dependency lookups', () => {
    const source = readFileSync(servicePath, 'utf8');

    expect(source).toContain('private topologyManagementService?: GroupTopologyManagementService;');
    expect(source).toContain('private rtcRttDependencies?: RtcRttAppInboxDependencies;');
    expect(source).toContain(
      'setTopologyManagementService(service: GroupTopologyManagementService)',
    );
    expect(source).toContain(
      'setRtcRttAppInboxDependencies(dependencies: RtcRttAppInboxDependencies)',
    );
    expect(source).toContain('requireTopologyManagementService(this.topologyManagementService)');
    expect(source).toContain('this.requireRtcRttAppInboxDependencies()');
  });

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

  it('requires each deferred family to register with complete dependencies', () => {
    const source = readFileSync(servicePath, 'utf8');

    expect(source).toContain('registerTopologyStateMessageHandlers(service)');
    expect(source).toContain('registerRtcRttStateMessageHandler(dependencies)');
    expect(source).not.toContain(
      'requireTopologyManagementService(this.topologyManagementService)',
    );
    expect(source).not.toContain('this.requireRtcRttAppInboxDependencies()');
  });
});
