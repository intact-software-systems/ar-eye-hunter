import { expect, test } from 'bun:test';

import { canBindLoopback, listenPort, readBindablePort } from './support/control-api-test-server.ts';

// A control server port drawn from the ephemeral range collides with the client sockets this
// suite opens against the servers it already started, and the spawned server then dies with
// AddrInUse instead of becoming healthy.
const EPHEMERAL_PORT_FLOOR = 32_768;
const PRIVILEGED_PORT_CEILING = 1_024;
const SAMPLED_PORTS = 128;

test('control server ports avoid the ephemeral range and ports already bound', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const held: ReturnType<typeof listenPort>[] = [];
    try {
        for (let sample = 0; sample < SAMPLED_PORTS; sample += 1) {
            const port = readBindablePort();
            expect(port).toBeGreaterThanOrEqual(PRIVILEGED_PORT_CEILING);
            expect(port).toBeLessThan(EPHEMERAL_PORT_FLOOR);
            held.push(listenPort('0.0.0.0', port));
        }
    }
    finally {
        for (const listener of held) {
            listener.stop();
        }
    }
});
