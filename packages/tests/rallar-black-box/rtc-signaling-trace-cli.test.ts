import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    analyzeRtcSignalingLogDirectory,
} from '../../../apps/rallar-black-box/scripts/analyze-rtc-signaling-logs.ts';

describe('RTC signaling trace CLI', () => {
    it('recursively reads shard logs and writes JSON and Markdown', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'rtc-signaling-logs-'));
        const logsDir = path.join(root, 'logs');
        const nestedDir = path.join(logsDir, 'worker-1');
        const outDir = path.join(root, 'analysis');
        await mkdir(nestedDir, { recursive: true });
        await writeFile(
            path.join(nestedDir, '7_Run headless worker shard.txt'),
            traceLine(),
        );
        await writeFile(
            path.join(nestedDir, 'ignored.txt'),
            traceLine('ignored-message'),
        );

        const analysis = await analyzeRtcSignalingLogDirectory(logsDir, outDir);

        expect(analysis.events).toBe(1);
        expect(analysis.messages).toBe(1);
        const written = JSON.parse(
            await readFile(path.join(outDir, 'analysis.json'), 'utf8'),
        ) as { events: number; messages: number };
        expect(written).toMatchObject({ events: 1, messages: 1 });
        await expect(readFile(path.join(outDir, 'summary.md'), 'utf8'))
            .resolves.toContain('RTC signaling boundary analysis');
    });

    it('rejects log directories without trace events', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'rtc-signaling-empty-'));
        await writeFile(
            path.join(root, '7_Run headless worker shard.txt'),
            'ordinary log line\n',
        );

        await expect(analyzeRtcSignalingLogDirectory(root, path.join(root, 'out')))
            .rejects.toThrow('No RTC signaling trace events');
    });
});

function traceLine(messageId = 'rtc-message-1'): string {
    return `2026-07-19T00:00:00Z RTC signaling trace: ${JSON.stringify({
        schemaVersion: 1,
        stage: 'client-outbox-enqueued',
        messageId,
        messageCreatedAtEpochMs: 1_000,
        atEpochMs: 1_010,
        elapsedMs: 10,
        signalType: 'Offer',
        fromId: 'sender',
        toId: 'target',
    })}\n`;
}
