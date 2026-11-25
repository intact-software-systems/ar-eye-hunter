import { expect, test, type APIRequestContext } from '@playwright/test';

import type { ControlEventEnvelope } from '../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeControlRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import {
    RALLAR_BLACK_BOX_RTC_CONNECT_ESTABLISHMENT_TIMEOUT_MS,
    RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS
} from '../../../packages/shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts';
import type { RallarBlackBoxTestCommand } from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    decodeRecord,
    decodeText
} from '../../../packages/shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';

import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin-ms.ts';
import { computeCommandResultWaitMs } from '@shared-test/rallar-bb-test/browser-test-budgets/compute-command-result-wait-ms.ts';
import { RALLAR_BLACK_BOX_EXPECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/playwright-expect-timeouts.ts';

const CONTROL_BASE_URL = 'http://127.0.0.1:5180';
const CONTROL_WS_URL = 'ws://127.0.0.1:5180/control';

/** How long the smoke polls the run for a result once the command may have ended. */
const RESULT_POLL_TIMEOUT_MS = 30_000;

/** How long the smoke polls the run's events for the connect and send evidence. */
const EVENT_POLL_TIMEOUT_MS = 10_000;

/** The send's own budget for opening the data channel and delivering. */
const SEND_TIMEOUT_MS = 20_000;

/** The agent page shows itself registered, and finally lists the send's result. */
const DEFAULT_LIMIT_ASSERTIONS = 2;

const apiBaseUrl = process.env.VITE_RALLAR_API_BASE_URL?.trim();
const roomId = process.env.VITE_RALLAR_ROOM_ID?.trim();
const username = process.env.VITE_RALLAR_USERNAME?.trim();
const password = process.env.VITE_RALLAR_PASSWORD?.trim();
const restoreSession = process.env.VITE_RALLAR_RESTORE_SESSION === 'true' ||
    process.env.VITE_RALLAR_RESTORE_SESSION === '1';
const restoreToken = process.env.VITE_RALLAR_TOKEN?.trim();
const restoreClientId = process.env.VITE_RALLAR_CLIENT_ID?.trim();
const restoreSessionId = process.env.VITE_RALLAR_SESSION_ID?.trim();
const restoreExpiresAt = Number.parseInt(
    process.env.VITE_RALLAR_EXPIRES_AT_EPOCH_MS ?? '',
    10
);
const peerIds = (process.env.VITE_RALLAR_REAL_PEER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

const canLogin = Boolean(username && password);
const canRestoreSession = Boolean(
    restoreSession &&
        restoreToken &&
        restoreClientId &&
        restoreSessionId &&
        username
);
const hasLiveConfig = Boolean(apiBaseUrl && roomId && (canLogin || canRestoreSession));

test.skip(
    !hasLiveConfig,
    'Set VITE_RALLAR_API_BASE_URL, VITE_RALLAR_ROOM_ID, and VITE_RALLAR_USERNAME/VITE_RALLAR_PASSWORD or a restorable VITE_RALLAR_* session to run the live browser-rallar smoke.'
);

function eventTopic(event: ControlEventEnvelope): string | undefined {
    return decodeText(decodeRecord(event.payload).topic);
}

async function fetchRun(
    request: APIRequestContext,
    runId: string
): Promise<ControlRunSnapshot> {
    const response = await request.get(
        `${CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}`
    );
    expect(response.ok()).toBe(true);
    return decodeControlRunSnapshot(await response.json()).fold(
        (issue) => {
            throw new Error(`Control run ${runId} could not be decoded: ${issue}`);
        },
        (snapshot) => snapshot
    );
}

async function enqueueCommand(
    request: APIRequestContext,
    runId: string,
    agentId: string,
    commandId: string,
    command: RallarBlackBoxTestCommand
): Promise<void> {
    const response = await request.post(
        `${CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/commands`,
        {
            data: {
                commandId,
                command
            }
        }
    );
    expect(response.status()).toBe(202);
}

test('browser-rallar provider performs live RTC connect and realtime send when configured', async ({ page, request }) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runId = `real-rallar-smoke-${suffix}`;
    const agentId = `real-rallar-agent-${suffix}`;
    const actor = process.env.VITE_RALLAR_ACTOR?.trim() || username || 'real-smoke';
    const connection = `real-rallar-rtc-${suffix}`;

    if (canRestoreSession) {
        await page.addInitScript((session) => {
            window.localStorage.setItem('auth.session', JSON.stringify(session));
        }, {
            clientId: restoreClientId,
            accessToken: restoreToken,
            username,
            sessionId: restoreSessionId,
            expiresAtEpochMs: Number.isFinite(restoreExpiresAt)
                ? restoreExpiresAt
                : Date.now() + 30 * 60 * 1000
        });
    }

    const query = new URLSearchParams({
        mode: 'control',
        provider: 'browser-rallar',
        controlUrl: CONTROL_WS_URL,
        runId,
        agentId,
        roomId: roomId ?? '',
        actor,
        transport: 'realtime',
        ...(canRestoreSession ? { rallarRestoreSession: '1' } : {})
    });

    await page.goto(`/?${query.toString()}`);
    await expect(page.locator('#panel-local-workbench .control-panel'))
        .toContainText('registered');

    const connectCommandId = `connect-${suffix}`;
    const connectCommand: RallarBlackBoxTestCommand = {
        kind: 'rtc.connect',
        connection,
        actor,
        roomId,
        transport: 'realtime',
        rallar: { timeoutMs: RALLAR_BLACK_BOX_RTC_CONNECT_ESTABLISHMENT_TIMEOUT_MS },
        timeoutMs: RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS
    };
    const sendCommandId = `send-${suffix}`;
    const sendCommand: RallarBlackBoxTestCommand = {
        kind: 'rtc.send',
        connection,
        transport: 'realtime',
        timeoutMs: SEND_TIMEOUT_MS,
        send: {
            roomId,
            ...(peerIds.length > 0 ? { peerIds } : {}),
            data: {
                topic: 'rallar.black-box.real-smoke',
                runId,
                agentId,
                suffix
            }
        }
    };
    const connectWaitMs = computeCommandResultWaitMs(connectCommand, RESULT_POLL_TIMEOUT_MS);
    const sendWaitMs = computeCommandResultWaitMs(sendCommand, RESULT_POLL_TIMEOUT_MS);
    test.setTimeout(
        BROWSER_TEST_HARNESS_MARGIN_MS + DEFAULT_LIMIT_ASSERTIONS * RALLAR_BLACK_BOX_EXPECT_TIMEOUT_MS + connectWaitMs +
            sendWaitMs + EVENT_POLL_TIMEOUT_MS
    );

    await enqueueCommand(request, runId, agentId, connectCommandId, connectCommand);
    await expect.poll(async () => {
        const run = await fetchRun(request, runId);
        return run.results.some((result) => result.commandId === connectCommandId && result.ok === true);
    }, {
        timeout: connectWaitMs
    }).toBe(true);

    await enqueueCommand(request, runId, agentId, sendCommandId, sendCommand);
    await expect.poll(async () => {
        const run = await fetchRun(request, runId);
        return run.results.some((result) => result.commandId === sendCommandId && result.ok === true);
    }, {
        timeout: sendWaitMs
    }).toBe(true);

    await expect.poll(async () => {
        const run = await fetchRun(request, runId);
        const topics = run.events
            .map(eventTopic)
            .filter((topic): topic is string => Boolean(topic));
        return {
            connected: topics.includes('rallar.browser.connect.phase_completed'),
            sent: topics.includes('rallar.browser.realtime.send_completed'),
            fakeTopicCount: topics.filter((topic) => topic.startsWith('rallar.bb.fake.')).length
        };
    }, {
        timeout: EVENT_POLL_TIMEOUT_MS
    }).toEqual({
        connected: true,
        sent: true,
        fakeTopicCount: 0
    });

    await expect(page.getByText(sendCommandId).first()).toBeVisible();
});
