import { expect, test, type APIRequestContext } from '@playwright/test';

const CONTROL_BASE_URL = 'http://127.0.0.1:5180';
const CONTROL_WS_URL = 'ws://127.0.0.1:5180/control';

type ControlResult = Readonly<{
    commandId?: string;
    ok?: boolean;
}>;

type ControlEvent = Readonly<{
    payload?: unknown;
}>;

type ControlRunSnapshot = Readonly<{
    results?: readonly ControlResult[];
    events?: readonly ControlEvent[];
}>;

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

function eventTopic(event: ControlEvent): string | undefined {
    const payload = event.payload;
    return payload && typeof payload === 'object' && 'topic' in payload
        ? String((payload as { topic?: unknown; }).topic ?? '')
        : undefined;
}

async function fetchRun(
    request: APIRequestContext,
    runId: string
): Promise<ControlRunSnapshot> {
    const response = await request.get(
        `${CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}`
    );
    expect(response.ok()).toBe(true);
    return await response.json() as ControlRunSnapshot;
}

async function enqueueCommand(
    request: APIRequestContext,
    runId: string,
    agentId: string,
    commandId: string,
    command: unknown
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
    await enqueueCommand(request, runId, agentId, connectCommandId, {
        kind: 'rtc.connect',
        connection,
        actor,
        roomId,
        transport: 'realtime',
        timeoutMs: 20_000
    });

    await expect.poll(async () => {
        const run = await fetchRun(request, runId);
        return run.results?.some((result) => result.commandId === connectCommandId && result.ok === true) ?? false;
    }, {
        timeout: 30_000
    }).toBe(true);

    const sendCommandId = `send-${suffix}`;
    await enqueueCommand(request, runId, agentId, sendCommandId, {
        kind: 'rtc.send',
        connection,
        transport: 'realtime',
        timeoutMs: 20_000,
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
    });

    await expect.poll(async () => {
        const run = await fetchRun(request, runId);
        return run.results?.some((result) => result.commandId === sendCommandId && result.ok === true) ?? false;
    }, {
        timeout: 30_000
    }).toBe(true);

    await expect.poll(async () => {
        const run = await fetchRun(request, runId);
        const topics = (run.events ?? [])
            .map(eventTopic)
            .filter((topic): topic is string => Boolean(topic));
        return {
            connected: topics.includes('rallar.browser.connect.phase_completed'),
            sent: topics.includes('rallar.browser.realtime.send_completed'),
            fakeTopicCount: topics.filter((topic) => topic.startsWith('rallar.bb.fake.')).length
        };
    }, {
        timeout: 10_000
    }).toEqual({
        connected: true,
        sent: true,
        fakeTopicCount: 0
    });

    await expect(page.getByText(sendCommandId).first()).toBeVisible();
});
