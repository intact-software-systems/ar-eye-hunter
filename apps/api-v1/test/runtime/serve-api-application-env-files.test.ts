import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IN_MEMORY_API_STARTUP_TIMEOUT_MS, startInMemoryApiProcess } from './in-memory-api-process.ts';

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('the served API takes an injected value over the same key in its env file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rallar-api-env-file-'));
    directories.push(directory);
    const envFile = join(directory, '.env');
    // A file port no test picks: if the file won, the server would report it instead of the injected one.
    writeFileSync(envFile, 'PORT=19999\n');

    const api = await startInMemoryApiProcess({ envFile });
    try {
        expect(api.listenedPort).toBe(api.port);
    }
    finally {
        api.child.kill('SIGKILL');
    }
}, IN_MEMORY_API_STARTUP_TIMEOUT_MS);
