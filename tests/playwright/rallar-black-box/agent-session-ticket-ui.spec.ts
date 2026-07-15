import { expect, type Page, test } from '@playwright/test';

import { FULL_STACK_CONTROL_WS_URL, FULL_STACK_SPA_ORIGIN } from './full-stack-helpers.ts';

type BrowserAuthSession = Readonly<{
  clientId: string;
  accessToken: string;
  username: string;
  sessionId: string;
  expiresAtEpochMs: number;
}>;

type AgentTicketRecord = Readonly<{
  agentId: string;
  ticket: string;
  sessionId: string;
  expiresAtEpochMs: number;
}>;

const API_BASE_URL = 'https://api.agent-session-ticket.test';

test.describe('rallar-black-box agent tab session tickets', () => {
  test('Open agent tabs consumes one-time tickets even when popups inherit sessionStorage auth', async ({
    context,
    page,
  }, testInfo) => {
    const suffix = `${Date.now()}-${testInfo.workerIndex}`;
    const operatorSession = createSession('alice', 'operator-session');
    const issuedTickets = new Map<string, AgentTicketRecord>();
    const consumedTickets: string[] = [];

    await context.addInitScript((session) => {
      window.sessionStorage.setItem('auth.session', JSON.stringify(session));
    }, operatorSession);
    await context.route(`${API_BASE_URL}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/config') {
        await route.fulfill({
          contentType: 'application/json',
          json: {
            apiBaseUrl: API_BASE_URL,
            wsBaseUrl: 'wss://api.agent-session-ticket.test',
            endpoints: {
              createWs: `${API_BASE_URL}/api/ws`,
            },
          },
        });
        return;
      }

      if (
        request.method() === 'POST' &&
        url.pathname === '/api/auth/agent-session-tickets'
      ) {
        const body = await request.postDataJSON() as { agentIds?: string[] };
        const agentIds = body.agentIds ?? [];
        const tickets = agentIds.map((agentId, index) => {
          const ticket = `ticket-${index + 1}-${agentId}`;
          const record = {
            agentId,
            ticket,
            sessionId: `fresh-${agentId}`,
            expiresAtEpochMs: Date.now() + 60_000,
          };
          issuedTickets.set(ticket, record);
          return record;
        });
        await route.fulfill({
          contentType: 'application/json',
          json: { tickets },
        });
        return;
      }

      if (
        request.method() === 'POST' &&
        url.pathname === '/api/auth/agent-session-tickets/consume'
      ) {
        const body = await request.postDataJSON() as { ticket?: string };
        const ticket = body.ticket ?? '';
        const issued = issuedTickets.get(ticket);
        if (!issued) {
          await route.fulfill({
            contentType: 'application/json',
            status: 404,
            json: { error: 'unknown ticket' },
          });
          return;
        }

        consumedTickets.push(ticket);
        await route.fulfill({
          contentType: 'application/json',
          json: createSession('alice', issued.sessionId),
        });
        return;
      }

      await route.fulfill({
        contentType: 'application/json',
        status: 404,
        json: { error: `Unhandled ${request.method()} ${url.pathname}` },
      });
    });

    const query = new URLSearchParams({
      provider: 'browser-rallar',
      workspace: 'black-box-runner',
      tab: 'recipes',
      apiBaseUrl: API_BASE_URL,
      applicationId: 'rallar-server',
      workspaceId: 'default',
      roomId: `agent-ticket-ui-${suffix}`,
      actor: 'alice',
      sessionId: operatorSession.sessionId,
      rallarAuthStorage: 'session',
      rallarRestoreSession: '1',
      controlUrl: FULL_STACK_CONTROL_WS_URL,
      runId: `agent-ticket-ui-run-${suffix}`,
      runnerAgentPrefix: 'controller',
      runnerAgentCount: '2',
    });

    await page.goto(`${FULL_STACK_SPA_ORIGIN}/?${query.toString()}`);
    await expect(page.getByRole('tab', { name: 'Recipes', exact: true }))
      .toHaveAttribute('aria-selected', 'true');

    const panel = page.locator('#panel-recipes');
    const popups: Page[] = [];
    page.on('popup', (popup) => popups.push(popup));
    await panel
      .locator('section[aria-label="Connect Agents"]')
      .getByRole('button', { name: 'Open agent tabs', exact: true })
      .click();

    await expect(panel).toContainText(
      'Opened 2 agent tabs with fresh one-time sessions.', {
      timeout: 15_000,
    });
    await expect.poll(() => popups.length, {
      timeout: 15_000,
    }).toBe(2);
    await expect.poll(() => consumedTickets.length, {
      timeout: 15_000,
    }).toBe(2);

    const popupSessions = await Promise.all(popups.map(readSessionStorageAuth));
    expect(popupSessions.map((session) => session.sessionId).sort()).toEqual(
      Array.from(issuedTickets.values()).map((ticket) => ticket.sessionId).sort(),
    );
    for (const session of popupSessions) {
      expect(session.sessionId).not.toBe(operatorSession.sessionId);
    }
    for (const popup of popups) {
      expect(new URL(popup.url()).hash).toBe('');
    }
  });
});

function createSession(username: string, sessionId: string): BrowserAuthSession {
  return {
    clientId: username,
    accessToken: `token-${sessionId}`,
    username,
    sessionId,
    expiresAtEpochMs: Date.now() + 60 * 60 * 1000,
  };
}

async function readSessionStorageAuth(page: Page): Promise<BrowserAuthSession> {
  await expect.poll(async () => {
    return await page.evaluate(() => window.sessionStorage.getItem('auth.session'));
  }, {
    timeout: 15_000,
  }).not.toBeNull();

  return await page.evaluate(() => {
    const raw = window.sessionStorage.getItem('auth.session');
    if (!raw) {
      throw new Error('Missing auth.session in popup sessionStorage.');
    }
    return JSON.parse(raw) as BrowserAuthSession;
  });
}
