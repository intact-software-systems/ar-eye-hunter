import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { RallarBlackBoxEventHistoryPolicy } from '../../../packages/shared-test/rallar-bb-test/runtime/event-history.ts';

import { readHeadlessWorkerConfig } from '../../../apps/rallar-black-box/src/headless-worker/headless-worker-config.ts';

const writer = path.resolve(__dirname, '../../../scripts/hosted-rallar/controller/rallar-headless-worker-env.sh');

function transportHistory(environment: Readonly<Record<string, string>>): Record<string, string> {
    const directory = mkdtempSync(path.join(tmpdir(), 'history-worker-env-'));
    const destination = path.join(directory, 'worker.env');
    try {
        execFileSync('bash', ['-c', 'source "$1"; write_rallar_headless_worker_env_file "$2"', 'bash', writer, destination], {
            env: { PATH: '/usr/bin:/bin', ...environment }
        });
        const lines = execFileSync('bash', ['-c', 'set -a; source "$1"; env', 'bash', destination], {
            env: { PATH: '/usr/bin:/bin' },
            encoding: 'utf8'
        }).split('\n');
        return Object.fromEntries(
            lines.filter((line) => line.startsWith('RALLAR_BLACK_BOX_EVENT_HISTORY=') || line.startsWith('RALLAR_BLACK_BOX_EVENT_HISTORY_MAX_EVENTS=')).map(
                (line) => {
                    const equals = line.indexOf('=');
                    return [line.slice(0, equals), line.slice(equals + 1)];
                }
            )
        );
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

const required = {
    RALLAR_BLACK_BOX_SPA_URL: 'https://fixture.test',
    RALLAR_BLACK_BOX_CONTROL_URL: 'wss://control.fixture.test/control',
    RALLAR_API_BASE_URL: 'https://api.fixture.test',
    RALLAR_BLACK_BOX_RUN_ID: 'fixture-run',
    RALLAR_BLACK_BOX_ROOM_ID: 'fixture-room',
    RALLAR_BLACK_BOX_USERNAME: 'fixture-user',
    RALLAR_BLACK_BOX_PASSWORD: 'fixture-password'
};

interface WorkerHistoryCase {
    readonly environment: Readonly<Record<string, string>>;
    readonly policy: RallarBlackBoxEventHistoryPolicy;
    readonly query: string;
}

describe('hosted worker event history environment', () => {
    it.each<WorkerHistoryCase>([
        { environment: {}, policy: { mode: 'full' }, query: 'full' },
        { environment: { RALLAR_BLACK_BOX_EVENT_HISTORY: 'full' }, policy: { mode: 'full' }, query: 'full' },
        {
            environment: { RALLAR_BLACK_BOX_EVENT_HISTORY: 'recent', RALLAR_BLACK_BOX_EVENT_HISTORY_MAX_EVENTS: '64' },
            policy: { mode: 'recent', maxEvents: 64 },
            query: 'recent'
        }
    ])('preserves configured $policy through the actual environment writer', ({ environment, policy, query }) => {
        const transported = transportHistory(environment);
        expect(transported).toEqual(environment);
        const config = readHeadlessWorkerConfig({ env: { ...required, ...transported } });
        expect(config.eventHistory).toEqual(policy);
        expect(new URL(config.agents[0].url).searchParams.get('eventHistory')).toBe(query);
        expect(new URL(config.agents[0].url).searchParams.get('eventHistoryMaxEvents')).toBe(policy.mode === 'recent' ? '64' : null);
    });

    it.each<Readonly<Record<string, string>>>([
        { RALLAR_BLACK_BOX_EVENT_HISTORY: 'recent' },
        { RALLAR_BLACK_BOX_EVENT_HISTORY_MAX_EVENTS: '64' },
        { RALLAR_BLACK_BOX_EVENT_HISTORY: 'full', RALLAR_BLACK_BOX_EVENT_HISTORY_MAX_EVENTS: '64' },
        { RALLAR_BLACK_BOX_EVENT_HISTORY: 'recent', RALLAR_BLACK_BOX_EVENT_HISTORY_MAX_EVENTS: '0' },
        { RALLAR_BLACK_BOX_EVENT_HISTORY: 'other' }
    ])('keeps malformed selections visible to canonical validation: %j', (environment) => {
        const transported = transportHistory(environment);
        expect(transported).toEqual(environment);
        expect(() => readHeadlessWorkerConfig({ env: { ...required, ...transported } })).toThrow(/Event history launch/);
    });
});
