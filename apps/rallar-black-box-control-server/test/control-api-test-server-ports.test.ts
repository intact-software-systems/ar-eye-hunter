import { assert } from '@std/assert';

import { canBindLoopback, readBindablePort } from './support/control-api-test-server.ts';

// A control server port drawn from the ephemeral range collides with the client sockets this
// suite opens against the servers it already started, and the spawned server then dies with
// AddrInUse instead of becoming healthy.
const EPHEMERAL_PORT_FLOOR = 32_768;
const PRIVILEGED_PORT_CEILING = 1_024;
const SAMPLED_PORTS = 128;

Deno.test('control server ports avoid the ephemeral range and ports already bound', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const held: Deno.Listener[] = [];
    try {
        for (let sample = 0; sample < SAMPLED_PORTS; sample += 1) {
            const port = readBindablePort();
            assert(port >= PRIVILEGED_PORT_CEILING, `port ${port} is privileged`);
            assert(port < EPHEMERAL_PORT_FLOOR, `port ${port} is inside the ephemeral range`);
            held.push(Deno.listen({
                hostname: '0.0.0.0',
                port
            }));
        }
    }
    finally {
        for (const listener of held) {
            listener.close();
        }
    }
});
