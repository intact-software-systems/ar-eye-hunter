import { sendApiHttpRequest } from '@shared-web/browser/api/send-api-http-request.ts';
import { writeSelectedViewWatch } from '@shared-web/browser/api/write-selected-view-watch.ts';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@shared-web/browser/api-client-config.ts', () => ({ readApiBaseUrl: () => 'http://api.test' }));
vi.mock('@shared-web/browser/api/send-api-http-request.ts', () => ({ sendApiHttpRequest: vi.fn() }));
const scope = { applicationId: 'game', workspaceId: 'default' };
const session = { clientId: 'alice', sessionId: 'alice-session', username: 'alice', accessToken: 'test', expiresAtEpochMs: 9_999_999_999_999 };
beforeEach(() => vi.resetAllMocks());

it.each(['session-preview', 'tournament'] as const)('preserves %s registration identity and predecessor after a lost acknowledgement', async (family) => {
    const requestId = 'session-preview-watch-request-0001';
    vi.mocked(sendApiHttpRequest).mockRejectedValueOnce(new Error('Response lost')).mockResolvedValue({
        status: 'applied',
        requestId,
        registrationId: requestId,
        resourceId: 'selected-resource'
    });
    const request = { resourceId: 'selected-resource', connectionGenerationId: 'connection-1', expectedRegistrationId: 'previous' };
    await expect(writeSelectedViewWatch({ ...scope, family }, { requestId, request, session, signal: new AbortController().signal }))
        .resolves.toMatchObject({ status: 'applied', registrationId: requestId });
    expect(sendApiHttpRequest).toHaveBeenCalledTimes(2);
    for (const [call] of vi.mocked(sendApiHttpRequest).mock.calls) {
        expect(call).toMatchObject({
            path: `/api/state/apps/game/workspaces/default/view-watches/${family}/requests/${requestId}`,
            body: request,
            options: { authSession: session }
        });
    }
});
