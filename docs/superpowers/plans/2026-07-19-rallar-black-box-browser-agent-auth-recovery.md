# Rallar Black Box Browser-Agent Auth Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover the Recipe Console from a server-rejected stored operator session so the visible **Open 3 browser agents** workflow returns to login on HTTP 401 and succeeds after fresh authentication.

**Architecture:** Keep auth ownership in `App` and add one narrow invalid-auth callback through the Recipe Console provider into the existing browser-agent launch service. Only a 401 from the protected agent-session-ticket request triggers invalidation; the current popup cleanup remains responsible for closing reserved blank tabs, and all other launch failures retain their inline behavior.

**Tech Stack:** React 19, TypeScript 7, Vitest, Playwright Chromium, Vite

## Global Constraints

- Preserve the existing browser-agent launch service API for callers that do not opt into auth invalidation.
- Invalidate only on `ApiHttpError.status === 401`; do not clear auth for HTTP 403, network, abort, validation, control-token, or popup failures.
- Preserve the original agent-ticket error even if the invalidation callback itself fails.
- Do not send a logout request with the rejected token.
- Keep simulated-provider launch, control-token brokerage, and successful three-agent popup behavior unchanged.
- Preserve the `App.tsx` 260-line structural boundary without weakening its test.
- Follow red-green-refactor: every production behavior change begins with a test observed failing for the expected reason.

---

### Task 1: Classify rejected agent-ticket auth at the launch boundary

**Files:**

- Modify: `packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts`
- Modify: `apps/rallar-black-box/src/browser-agent-launch-service.ts`

**Interfaces:**

- Consumes: `ApiHttpError` from `@shared-web/browser/api-integration.ts`.
- Produces: optional `onAuthInvalid(error: unknown): void | Promise<void>` configuration on `createBrowserAgentLaunchService(...)`.
- Preserves: `BrowserAgentLaunchService.prepare(...)` and `PreparedBrowserAgentCohort` public shapes.

- [ ] **Step 1: Write the failing 401 and non-401 service tests**

Add `ApiHttpError` to the test imports and place this describe block beside the existing `Recipe Console browser-agent launch service` tests:

```typescript
import { ApiHttpError } from '../../shared-web/browser/api-integration.ts';

describe('Recipe Console browser-agent launch auth recovery', () => {
    const authSession: AuthSession = {
        clientId: 'operator-client',
        accessToken: 'rejected-access-token',
        username: 'operator',
        sessionId: 'operator-session',
        expiresAtEpochMs: 4_000_000_000_000
    };
    const issueRunToken = vi.fn(async ({ runId, agentId }: {
        runId: string;
        agentId: string;
    }) => ({
        runId,
        agentId,
        token: `control-${agentId}`,
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 61_000
    }));

    it('invalidates a rejected operator session and preserves the ticket 401', async () => {
        const unauthorized = new ApiHttpError(
            'POST',
            '/api/auth/agent-session-tickets',
            401,
            '{"error":"Unauthorized: Invalid or expired access token"}'
        );
        const onAuthInvalid = vi.fn(() => {
            throw new Error('cleanup failed');
        });
        const service = createBrowserAgentLaunchService({
            origin: 'https://blackbox.example.test',
            providerMode: 'browser-rallar',
            controlWsUrl: 'wss://control.example.test/control',
            apiBaseUrl: 'https://api.example.test',
            authSession,
            issueRunToken,
            issueAgentTickets: async () => {
                throw unauthorized;
            },
            onAuthInvalid
        });

        await expect(service.prepare({
            runId: 'run-1',
            agentIds: ['browser-1', 'browser-2', 'browser-3'],
            group
        })).rejects.toBe(unauthorized);
        expect(onAuthInvalid).toHaveBeenCalledOnce();
        expect(onAuthInvalid).toHaveBeenCalledWith(unauthorized);
        expect(issueRunToken).not.toHaveBeenCalled();
    });

    it('does not invalidate a valid session for a non-401 ticket failure', async () => {
        const forbidden = new ApiHttpError(
            'POST',
            '/api/auth/agent-session-tickets',
            403,
            '{"error":"Forbidden"}'
        );
        const onAuthInvalid = vi.fn();
        const service = createBrowserAgentLaunchService({
            origin: 'https://blackbox.example.test',
            providerMode: 'browser-rallar',
            controlWsUrl: 'wss://control.example.test/control',
            apiBaseUrl: 'https://api.example.test',
            authSession,
            issueRunToken,
            issueAgentTickets: async () => {
                throw forbidden;
            },
            onAuthInvalid
        });

        await expect(service.prepare({
            runId: 'run-1',
            agentIds: ['browser-1'],
            group
        })).rejects.toBe(forbidden);
        expect(onAuthInvalid).not.toHaveBeenCalled();
        expect(issueRunToken).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts
```

Expected: FAIL because the launch service does not yet accept or call `onAuthInvalid`; the 401 test observes zero invalidation calls.

- [ ] **Step 3: Implement the minimal 401 callback**

Change the API-integration import and the launch-service configuration:

```typescript
import {
    ApiHttpError,
    issueAgentSessionTicketsAt,
} from '@shared-web/browser/api-integration.ts';

export function createBrowserAgentLaunchService(config: Readonly<{
    origin: string;
    providerMode: RallarBlackBoxProviderMode;
    controlWsUrl: string;
    apiBaseUrl: string;
    authSession?: AuthSession;
    issueAgentSessions?: boolean;
    allowAnonymousControlToken?: boolean;
    allowSharedControlToken?: boolean;
    issueRunToken: IssueRunToken;
    issueAgentTickets?: IssueAgentTickets;
    onAuthInvalid?: (error: unknown) => void | Promise<void>;
}>): BrowserAgentLaunchService {
```

Wrap only the protected ticket request in `issueTickets(...)`:

```typescript
let response: AgentSessionTicketResponse;
try {
    response = await (config.issueAgentTickets ?? issueAgentSessionTicketsAt)(
        config.apiBaseUrl,
        { agentIds },
        { authSession: config.authSession, signal }
    );
}
catch (error) {
    if (error instanceof ApiHttpError && error.status === 401) {
        try {
            await config.onAuthInvalid?.(error);
        }
        catch {
            // Auth recovery must not replace the actionable API failure.
        }
    }
    throw error;
}
```

Leave ticket validation, control-token minting, and launch URL construction unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts
```

Expected: PASS, including the existing service, provider-boundary, control-token, legacy-compatibility, and popup tests.

- [ ] **Step 5: Commit the launch-boundary behavior**

```bash
git add apps/rallar-black-box/src/browser-agent-launch-service.ts packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts
git commit -m "fix: classify browser agent ticket auth failures"
```

---

### Task 2: Return the stale-session operator to login from the visible flow

**Files:**

- Modify: `tests/playwright/rallar-black-box/recipe-console-agent-launch.spec.ts`
- Modify: `apps/rallar-black-box/src/App.tsx`
- Modify: `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx`
- Modify: `apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx`

**Interfaces:**

- Consumes: `onAuthInvalid(error)` emitted by Task 1.
- Produces: app-owned clearing of `auth.session` and `authSession`, followed by the existing `LoginScreen` branch.
- Preserves: direct `ControlConnectionProvider` test and app consumers by keeping its callback prop optional.

- [ ] **Step 1: Write the failing visible-control Playwright regression**

Add the API route constant near `CONTROL_ROUTE`:

```typescript
const API_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):8080\/.*/;
```

Add this test after the successful three-agent flow:

```typescript
test('returns a rejected stored operator session to login and closes reserved tabs', async ({ context, page }) => {
    const control = await installAgentLaunchControl(context, {
        registerOnToken: false
    });
    await context.addInitScript(() => {
        localStorage.setItem(
            'auth.session',
            JSON.stringify({
                clientId: 'stale-operator-client',
                accessToken: 'server-rejected-access-token',
                username: 'stale-operator',
                sessionId: 'stale-operator-session',
                expiresAtEpochMs: 4_000_000_000_000
            })
        );
    });
    let ticketRequests = 0;
    await context.route(API_ROUTE, async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (request.method() === 'OPTIONS') {
            await fulfillApiPreflight(route);
            return;
        }
        if (
            request.method() === 'POST' &&
            pathname === '/api/auth/agent-session-tickets'
        ) {
            ticketRequests += 1;
            await fulfillJson(route, {
                error: 'Unauthorized: Invalid or expired access token'
            }, 401);
            return;
        }
        await fulfillJson(route, { error: 'Unhandled API request.' }, 404);
    });

    await page.goto(
        EXECUTE_ROUTE.replace('provider=simulated', 'provider=browser-rallar')
    );
    await page.getByLabel('Control run ID for new agents')
        .fill('stale-session-run');
    const childPages: Page[] = [];
    context.on('page', (child) => {
        if (child !== page) {
            childPages.push(child);
        }
    });
    await page.getByRole('button', { name: 'Open 3 browser agents' }).click();

    await expect(page.getByRole('heading', { name: 'Rallar Server Login' }))
        .toBeVisible();
    await expect.poll(() => childPages.length).toBe(3);
    await expect.poll(
        () => childPages.filter((child) => !child.isClosed()).length
    ).toBe(0);
    await expect.poll(
        async () => await page.evaluate(() => localStorage.getItem('auth.session'))
    ).toBeNull();
    expect(ticketRequests).toBe(1);
    expect(control.tokenRequests).toHaveLength(0);
});
```

Add the preflight helper above `fulfillJson(...)`:

```typescript
async function fulfillApiPreflight(route: Route): Promise<void> {
    await route.fulfill({
        status: 204,
        headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'authorization, content-type, x-client-id'
        }
    });
}
```

- [ ] **Step 2: Run the new Playwright test and verify RED**

Run:

```bash
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts tests/playwright/rallar-black-box/recipe-console-agent-launch.spec.ts --project=chromium --grep "returns a rejected stored operator session"
```

Expected: FAIL because the Recipe Console remains mounted with the raw 401 status instead of rendering `Rallar Server Login`; `auth.session` remains stored.

- [ ] **Step 3: Wire app-owned invalidation through Recipe Console**

Add a required callback to `RecipeConsoleAppProps`, destructure it, and pass it to the provider:

```typescript
export type RecipeConsoleAppProps = Readonly<{
    authSession?: AuthSession;
    authBusy: boolean;
    authError?: string;
    controlBootstrap: RecipeConsoleControlBootstrap;
    onAuthInvalid(error: unknown): void | Promise<void>;
    onLogout(): Promise<void>;
}>;
```

```tsx
export default function RecipeConsoleApp({
    authSession,
    authBusy,
    authError,
    controlBootstrap,
    onAuthInvalid,
    onLogout,
}: RecipeConsoleAppProps) {
```

```tsx
<ControlConnectionProvider
    authSession={authSession}
    bootstrap={preferences.state.effectiveBootstrap}
    controlReadTimeoutMs={preferences.state.controlReadTimeoutMs}
    onAuthInvalid={onAuthInvalid}
>
```

Add the optional callback to `ControlConnectionProvider`, forward it to the launch service, and include it in the memo dependencies:

```typescript
export function ControlConnectionProvider({
    authSession,
    bootstrap,
    children,
    controlReadTimeoutMs,
    onAuthInvalid,
}: Readonly<{
    authSession?: AuthSession;
    bootstrap: RecipeConsoleControlBootstrap;
    children: ReactNode;
    controlReadTimeoutMs?: number;
    onAuthInvalid?: (error: unknown) => void | Promise<void>;
}>) {
```

```typescript
? createBrowserAgentLaunchService({
    origin: globalThis.location?.origin ?? 'http://localhost:5176',
    providerMode: bootstrap.providerMode,
    controlWsUrl: controlWebSocketUrlFromHttpBaseUrl(apiSetup.api.baseUrl),
    apiBaseUrl: bootstrap.apiBaseUrl,
    authSession,
    issueRunToken: apiSetup.api.agentLaunch.issueRunToken,
    onAuthInvalid,
})
```

```typescript
    browserAgentLaunchIssue,
    onAuthInvalid,
]);
```

In `App`, add the idempotent local invalidation handler before `logout` and pass it to the lazy Recipe Console:

```typescript
const invalidateAuthSession = (): void => {
    clearSession();
    setAuthSession(undefined);
    setAuthBusy(false);
    setAuthError(undefined);
};
```

```tsx
onAuthInvalid = { invalidateAuthSession };
onLogout = { logout };
```

Remove five blank separator lines in `App.tsx` while making these adjacent edits so the existing 260-line structural limit remains true; do not compress logic or change the limit.

- [ ] **Step 4: Run the new Playwright test and verify GREEN**

Run:

```bash
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts tests/playwright/rallar-black-box/recipe-console-agent-launch.spec.ts --project=chromium --grep "returns a rejected stored operator session"
```

Expected: PASS with one rejected ticket request, zero control-token requests, three reserved child pages closed, cleared `auth.session`, and the login heading visible.

- [ ] **Step 5: Run structural and focused unit checks**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts packages/tests/rallar-black-box/recipe-console-structure.test.ts packages/tests/rallar-black-box/auth-lifecycle.test.ts
```

Expected: PASS, including the existing `App.tsx` size boundary and Recipe Console ownership checks.

- [ ] **Step 6: Commit the end-to-end recovery**

```bash
git add apps/rallar-black-box/src/App.tsx apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx tests/playwright/rallar-black-box/recipe-console-agent-launch.spec.ts
git commit -m "fix: recover browser agent launch from stale auth"
```

---

### Task 3: Verify successful launch compatibility and app integrity

**Files:**

- Verify: `apps/rallar-black-box/src/**`
- Verify: `packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts`
- Verify: `tests/playwright/rallar-black-box/recipe-console-agent-launch.spec.ts`

**Interfaces:**

- Consumes: completed Task 1 and Task 2 behavior.
- Produces: verification evidence for stale-session recovery and preserved valid three-agent launch behavior.

- [ ] **Step 1: Run the complete focused Vitest set**

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts packages/tests/rallar-black-box/recipe-console-structure.test.ts packages/tests/rallar-black-box/auth-lifecycle.test.ts
```

Expected: all tests pass with no warnings or unhandled errors.

- [ ] **Step 2: Run the full browser-agent Playwright spec**

```bash
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts tests/playwright/rallar-black-box/recipe-console-agent-launch.spec.ts --project=chromium
```

Expected: all browser-agent launch tests pass, including both the server-rejected session recovery and the original successful **Open 3 browser agents** flow.

- [ ] **Step 3: Type-check and build the affected app**

```bash
npm --workspace rallar-black-box run typecheck
npm --workspace rallar-black-box run build
```

Expected: both commands exit zero. If Vite emits a known large-chunk warning, record it as a passing build with warning.

- [ ] **Step 4: Inspect the final diff and whitespace**

```bash
git diff --check HEAD~2..HEAD
git status --short
```

Expected: no whitespace errors and no uncommitted task files. Do not include unrelated workspace changes in either task commit.

- [ ] **Step 5: Record the completion handoff**

Report:

- files and behavior changed;
- why invalidation is limited to the ticket endpoint's HTTP 401;
- exact pass/fail/skipped result for every command above;
- whether production deployment and post-deploy Chrome verification remain for the operator.
