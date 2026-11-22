import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { classifyClaimReceipt, withExpiryWorkerStopped } from '../../shared-test/black-box-runner/cluster-proofs/seat-deadline-qualification.mts';

describe('claim receipt evidence on the claim server clock', () => {
    it('requires both time bounds to exclude the deadline before attributing a side', () => {
        expect(classifyClaimReceipt({ before: 90, after: 99, deadline: 100 })).toBe('before');
        expect(classifyClaimReceipt({ before: 99, after: 100, deadline: 100 })).toBe('overlaps');
        expect(classifyClaimReceipt({ before: 100, after: 108, deadline: 100 })).toBe('at-or-after');
    });
    it('rejects backward time or an invalid epoch', () => {
        expect(() => classifyClaimReceipt({ before: 102, after: 98, deadline: 100 })).toThrow();
        expect(() => classifyClaimReceipt({ before: NaN, after: 101, deadline: 100 })).toThrow();
    });
});

it('refuses a misrouted direct clock before sending account credentials or controlling the worker', async () => {
    const requests: string[] = [];
    const nodes = ['claim-clock', 'unexpected-clock'].map(peerId => createServer((request, response) => {
        requests.push(request.method + ' ' + request.url);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ serverPeerId: peerId, serverNowEpochMs: Date.now() }));
    }));
    try {
        const [claim, expiry] = await Promise.all(nodes.map(async node => {
            node.listen(0, '127.0.0.1');
            await once(node, 'listening');
            const address = node.address();
            if (!address || typeof address === 'string') throw new Error('Expected a TCP origin');
            return 'http://127.0.0.1:' + address.port;
        }));
        await expect(promisify(execFile)('bun', ['run',
            'packages/shared-test/black-box-runner/cluster-proofs/api-v1-seat-deadline-proof.mts',
            '--direct', claim!, 'claim-clock', expiry!, 'expiry-clock', '25'
        ], { env: { ...process.env, SEAT_PROOF_WORKER_CONTROL: '/unused-disposable-controller' } }))
            .rejects.toMatchObject({ stderr: expect.stringContaining('Time sample unavailable for expiry-clock: invalid-response') });
        expect(requests).toEqual(['GET /api/time', 'GET /api/time']);
    } finally {
        await Promise.all(nodes.map(node => new Promise<void>(resolve => node.close(() => resolve()))));
    }
});

it('attempts recovery after a partial stop and preserves both control failures', async () => {
    const calls: string[] = [];
    const stopFailure = new Error('Lost stop acknowledgement');
    const startFailure = new Error('Start failed');
    const result = withExpiryWorkerStopped({
        async stopExpiry() { calls.push('stop'); throw stopFailure; },
        async startExpiry() { calls.push('start'); throw startFailure; }
    }, async () => { calls.push('observe'); });
    await expect(result).rejects.toMatchObject({ error: startFailure, suppressed: stopFailure });
    expect(calls).toEqual(['stop', 'start']);
});
