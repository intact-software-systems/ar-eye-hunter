import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../apps/rallar-black-box/scripts/filter-alm-server-timing.mjs', import.meta.url));

it('retains only bounded ALM server timing fields without echoing raw structured logs', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'alm-timing-'));
    const artifact = path.join(directory, 'server-timing.jsonl');
    writeFileSync(artifact, 'stale-sensitive-data\n');
    const safe = {
        type: 'rallar.timing',
        component: 'queuebox-pubsub',
        operation: 'outbox-direct-send',
        status: 'ok',
        atEpochMs: 123,
        serviceId: 'private-session',
        details: {
            messageTopicId: 'room.alm-conformance',
            msgId: 'alm-message-1',
            keyTopicId: 'AL_OUTBOUND_MESSAGE',
            keyResourceId: 'scope-abc123',
            keyContextId: 'message-def456',
            deliveryStatus: 'sent-live',
            recipientCount: 2,
            sentCount: 1,
            failedCount: 1,
            token: 'secret-token',
            payload: { secret: 'secret-payload' }
        },
        error: { message: 'secret-error' }
    };
    const unrelated = { ...safe, details: { ...safe.details, messageTopicId: 'private.auth' } };
    const unsafeKey = { ...safe, details: { ...safe.details, keyContextId: 'session-secret' } };
    const unsafeVerdict = { ...safe, details: { ...safe.details, deliveryStatus: 'credential-leak' } };
    const lines = [
        JSON.stringify(safe),
        JSON.stringify(unrelated),
        JSON.stringify(unsafeKey),
        JSON.stringify(unsafeVerdict),
        'null',
        'plain API log'
    ]
        .join('\n') + '\n';

    const result = spawnSync(process.execPath, [script, artifact], { input: lines, encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('plain API log\n');
    expect(readFileSync(artifact, 'utf8')).toBe(
        JSON.stringify({
            atEpochMs: 123,
            component: 'queuebox-pubsub',
            operation: 'outbox-direct-send',
            status: 'ok',
            msgId: 'alm-message-1',
            outboxKey: {
                topicId: 'AL_OUTBOUND_MESSAGE',
                resourceId: 'scope-abc123',
                contextId: 'message-def456'
            },
            deliveryStatus: 'sent-live',
            recipientCount: 2,
            sentCount: 1,
            failedCount: 1
        }) + '\n'
    );
});

it('preserves the API failure exit status and stderr through the timing pipe', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'alm-timing-exit-'));
    const artifact = path.join(directory, 'server-timing.jsonl');
    const command = `node -e 'console.log("ready"); console.error("startup failed"); process.exit(7)' | ` +
        `node '${script}' '${artifact}'`;

    const result = spawnSync('bash', ['-o', 'pipefail', '-c', command], { encoding: 'utf8' });

    expect(result.status).toBe(7);
    expect(result.stdout).toBe('ready\n');
    expect(result.stderr).toBe('startup failed\n');
    expect(readFileSync(artifact, 'utf8')).toBe('');
});
