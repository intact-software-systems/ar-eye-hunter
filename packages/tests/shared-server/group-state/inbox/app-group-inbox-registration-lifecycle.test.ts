import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

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
