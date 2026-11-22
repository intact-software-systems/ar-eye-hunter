import * as Playwright from '@playwright/test';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';

import { readControlRun } from '../../../tests/playwright/rallar-black-box/full-stack-helpers.ts';
import { isControlTransportFailure } from '../../../tests/playwright/rallar-black-box/read-control-get-response.ts';

const snapshot = {
    runId: 'run',
    createdAtEpochMs: 1,
    updatedAtEpochMs: 2,
    agents: [],
    commands: [],
    results: [],
    events: [],
    stats: [],
    reports: [],
    heartbeats: []
} satisfies ControlRunSnapshot;

interface AnsweringControlServer {
    readonly url: string;
    readonly answered: () => number;
}

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of closers.splice(0).reverse()) {
        await close();
    }
});

describe('a control transport failure', () => {
    it.each([
        { failure: new Error('apiRequestContext.get: read ECONNRESET'), retryable: true },
        { failure: new Error('apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:5180'), retryable: true },
        { failure: new Error('apiRequestContext.get: 503 Service Unavailable'), retryable: false },
        { failure: new Error('Invalid control run snapshot: results'), retryable: false }
    ])('is retryable only for a reset or refused connection: $failure', ({ failure, retryable }) => {
        expect(isControlTransportFailure(failure)).toBe(retryable);
    });
});

describe('a control run read', () => {
    it('re-reads the run when the control server resets the connection once', async () => {
        const server = await openAnsweringControlServer(200);
        const request = await openRequest();
        const get = request.get.bind(request);
        vi.spyOn(request, 'get')
            .mockRejectedValueOnce(new Error('apiRequestContext.get: read ECONNRESET'))
            .mockImplementation(async () => await get(server.url));

        await expect(readControlRun(request, 'run')).resolves.toEqual(snapshot);
        expect(server.answered()).toBe(1);
    });

    it('gives up after the bound and throws the last transport error', async () => {
        const request = await openRequest();
        const last = new Error('apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:5180');
        // A fourth read would reject with its own error, so the last error proves the bound.
        vi.spyOn(request, 'get')
            .mockRejectedValueOnce(new Error('apiRequestContext.get: read ECONNRESET'))
            .mockRejectedValueOnce(new Error('apiRequestContext.get: read ECONNRESET'))
            .mockRejectedValueOnce(last)
            .mockRejectedValue(new Error('apiRequestContext.get: read ECONNRESET past the bound'));

        await expect(readControlRun(request, 'run')).rejects.toBe(last);
    });

    it('does not retry an HTTP error response', async () => {
        const server = await openAnsweringControlServer(503);
        const request = await openRequest();
        const get = request.get.bind(request);
        vi.spyOn(request, 'get').mockImplementation(async () => await get(server.url));

        await expect(readControlRun(request, 'run')).rejects.toThrow();
        expect(server.answered()).toBe(1);
    });
});

async function openRequest(): Promise<Playwright.APIRequestContext> {
    const request = await Playwright.request.newContext();
    closers.push(async () => await request.dispose());
    return request;
}

async function openAnsweringControlServer(status: number): Promise<AnsweringControlServer> {
    let answered = 0;
    const server: Server = createServer((_request, response) => {
        answered += 1;
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(snapshot));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('The test control server did not bind an HTTP port.');
    }
    closers.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    return { url: `http://127.0.0.1:${address.port}/runs/run`, answered: () => answered };
}
