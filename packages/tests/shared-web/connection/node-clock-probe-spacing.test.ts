import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('finishes a failed clock sample pair before starting another observation', async () => {
    const failed = createServer((_request, response) => response.writeHead(503).end());
    let active = 0;
    let peak = 0;
    let completed = 0;
    const slow = createServer((_request, response) => {
        peak = Math.max(peak, ++active);
        setTimeout(() => {
            active--;
            completed++;
            response.writeHead(503).end();
        }, 150);
    });
    async function listen(server: typeof slow) {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Expected a TCP port.');
        }
        return 'http://127.0.0.1:' + address.port;
    }
    try {
        const [first, second] = await Promise.all([listen(failed), listen(slow)]);
        await expect(
            promisify(execFile)('bun', [
                'run',
                'examples/browser-startup-room/check-node-clock-offset.ts',
                first,
                'first',
                second,
                'second',
                '25',
                '3',
                '5'
            ])
        ).rejects.toMatchObject({ code: 2 });
        expect(peak).toBe(1);
        expect(completed).toBe(3);
    }
    finally {
        await Promise.all([failed, slow].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
});
