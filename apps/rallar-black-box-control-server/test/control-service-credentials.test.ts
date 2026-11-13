import { expect, test } from 'bun:test';

import { createRallarBlackBoxControlService } from '../src/control-service.ts';
import { toControlServiceInput } from './support/control-service-test-fixtures.ts';

test('run credentials use a dedicated injected token source and keep identity and expiry fences', () => {
    let now = 1_000;
    const defaults = toControlServiceInput({ now: () => now, createCommandId: () => 'public-command-id' });
    const input = { ...defaults, dependencies: { ...defaults.dependencies, createRunToken: () => 'credential-from-dedicated-source' } };
    const service = createRallarBlackBoxControlService(input);
    const token = service.issueRunToken({ runId: 'run', agentId: 'agent', ttlMs: 100 });
    expect(token.token).toEqual('credential-from-dedicated-source');
    expect(service.validateRunToken('run', 'agent', token.token)).toEqual(true);
    expect(service.validateRunToken('other-run', 'agent', token.token)).toEqual(false);
    expect(service.validateRunToken('run', 'other-agent', token.token)).toEqual(false);
    expect(service.validateRunToken('run', 'agent', 'public-command-id')).toEqual(false);
    now = 1_100;
    expect(service.validateRunToken('run', 'agent', token.token)).toEqual(false);
});
