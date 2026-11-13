import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createDefaultFullStackApiV1WebServer } from '../../../apps/rallar-black-box/playwright-full-stack-api-server.ts';

describe.each(['memory', 'postgres'] as const)('%s API shell launch', (mode) => {
    it.each([
        ['http://localhost:5177', 'http://localhost:5177,http://127.0.0.1:5177'],
        ['http://127.0.0.1:5178', 'http://127.0.0.1:5178,http://localhost:5178'],
        ['http://a&b:5177', 'http://a&b:5177']
    ])('launches with literal URL values and granted-topic JSON for %s', async (spaBaseUrl, cors) => {
        const directory = await mkdtemp(join(tmpdir(), 'rallar-api-environment-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        await writeFile(
            join(directory, 'bun'),
            `#!/bin/sh
exec node -e 'process.stdout.write(JSON.stringify({api:process.env.RALLAR_API_BASE_URL,ws:process.env.RALLAR_WS_BASE_URL,topics:JSON.parse(process.env.RALLAR_GRANTED_WS_TOPICS_JSON),cors:process.env.CORS_ORIGINS}))'
`,
            { mode: 0o700 }
        );
        const server = createDefaultFullStackApiV1WebServer({
            mode,
            apiBaseUrl: 'http://localhost:18080/$(printf injected)?a=1&b=2',
            spaBaseUrl,
            environment: {}
        });
        const output = execFileSync('/bin/sh', ['-c', server.command], {
            cwd: resolve('apps/rallar-black-box'),
            env: {
                ...process.env,
                DATABASE_URL: 'postgres://unused:unused@localhost/unused',
                PATH: `${directory}:${process.env.PATH}`
            },
            encoding: 'utf8'
        });
        expect(JSON.parse(output)).toEqual({
            api: 'http://localhost:18080/$(printf injected)?a=1&b=2',
            ws: 'ws://localhost:18080/$(printf%20injected)?a=1&b=2',
            cors,
            topics: [{ topicId: 'room.alm-conformance-granted', fanout: 'outbox', serverProducerIds: [] }]
        });
    });
});
