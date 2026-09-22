import { assertEquals } from '@std/assert';

import { createRallarBlackBoxControlService } from '../src/control-service.ts';
import { toControlServiceInput } from './support/control-service-test-fixtures.ts';

Deno.test('run credentials use a dedicated injected token source and keep identity and expiry fences', () => {
    let now = 1_000;
    const defaults = toControlServiceInput({ now: () => now, createCommandId: () => 'public-command-id' });
    const input = { ...defaults, dependencies: { ...defaults.dependencies, createRunToken: () => 'credential-from-dedicated-source' } };
    const service = createRallarBlackBoxControlService(input);
    const token = service.issueRunToken({ runId: 'run', agentId: 'agent', ttlMs: 100 });
    assertEquals(token.token, 'credential-from-dedicated-source');
    assertEquals(service.validateRunToken('run', 'agent', token.token), true);
    assertEquals(service.validateRunToken('other-run', 'agent', token.token), false);
    assertEquals(service.validateRunToken('run', 'other-agent', token.token), false);
    assertEquals(service.validateRunToken('run', 'agent', 'public-command-id'), false);
    now = 1_100;
    assertEquals(service.validateRunToken('run', 'agent', token.token), false);
});
