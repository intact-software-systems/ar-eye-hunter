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
import { readControlGetResponse } from '../../../tests/playwright/rallar-black-box/read-control-get-response.ts';

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

describe('a control GET', () => {
    it.each([
        { case: 'a reset known by its code', failure: toCodedError('apiRequestContext.get: socket hang up', 'ECONNRESET'), reread: true },
        { case: 'a refusal known by its code', failure: toCodedError('apiRequestContext.get: connect failed', 'ECONNREFUSED'), reread: true },
        { case: 'a reset known only by its message', failure: new Error('apiRequestContext.get: read ECONNRESET'), reread: true },
        { case: 'a timeout', failure: new Error('apiRequestContext.get: Timeout 30000ms exceeded.'), reread: false },
        { case: 'another system error', failure: toCodedError('apiRequestContext.get: getaddrinfo ENOTFOUND control', 'ENOTFOUND'), reread: false }
    ])('re-reads after $case only when the request produced no answer because the connection failed', async ({ failure, reread }) => {
        const server = await openAnsweringControlServer(200);
        const request = await openRequest();
        const get = request.get.bind(request);
        vi.spyOn(request, 'get')
            .mockRejectedValueOnce(failure)
            .mockImplementation(async () => await get(server.url));

        const read = readControlGetResponse(async () => await request.get(server.url));

        if (reread) {
            await expect(read.then((response) => response.status())).resolves.toBe(200);
        }
        else {
            await expect(read).rejects.toBe(failure);
        }
        expect(server.answered()).toBe(reread ? 1 : 0);
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

/** A rejection as Playwright's request context gives it, with the system error code the server side reported. */
function toCodedError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}
