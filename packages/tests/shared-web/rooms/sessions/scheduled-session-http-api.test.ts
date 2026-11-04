import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { sendApiHttpRequest } from '@shared-web/browser/api/send-api-http-request.ts';
import { changeSessionPreviewWatch, scheduledSessionHttpApi } from '@shared-web/browser/rooms/sessions/scheduled-session-http-api.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from '../../authoritative-group-fixtures.ts';

vi.mock('@shared-web/browser/api-client-config.ts', () => ({ readApiBaseUrl: () => 'http://api.test' }));
vi.mock('@shared-web/browser/api/send-api-http-request.ts', () => ({ sendApiHttpRequest: vi.fn() }));
const scope = { applicationId: 'game', workspaceId: 'default' };
const ref = { ...scope, groupId: 'scheduled' };
const session = { clientId: 'alice', sessionId: 'alice-session', username: 'alice', accessToken: 'test', expiresAtEpochMs: 9_999_999_999_999 };

beforeEach(() => vi.resetAllMocks());

describe('scheduled-session HTTP acknowledgement', () => {
    it('preserves registration identity and predecessor after a lost acknowledgement', async () => {
        const requestId = 'session-preview-watch-request-0001';
        vi.mocked(sendApiHttpRequest).mockRejectedValueOnce(new Error('Response lost')).mockResolvedValue({
            status: 'applied',
            requestId,
            registrationId: requestId,
            groupId: ref.groupId
        });
        const request = { groupId: ref.groupId, connectionGenerationId: 'connection-1', expectedRegistrationId: 'previous' };
        await expect(changeSessionPreviewWatch(scope, { requestId, request, session, signal: new AbortController().signal }))
            .resolves.toMatchObject({ status: 'applied', registrationId: requestId });
        expect(sendApiHttpRequest).toHaveBeenCalledTimes(2);
        for (const [call] of vi.mocked(sendApiHttpRequest).mock.calls) {
            expect(call).toMatchObject({
                path: `/api/state/apps/game/workspaces/default/view-watches/session-preview/requests/${requestId}`,
                body: request,
                options: { authSession: session }
            });
        }
    });

    it('keeps a missing preview absent and propagates an authority denial', async () => {
        vi.mocked(sendApiHttpRequest).mockRejectedValueOnce(new ApiHttpError('GET', '/session', 404, 'Missing'));
        await expect(scheduledSessionHttpApi.read(ref, session, new AbortController().signal)).resolves.toBeNull();
        const denied = new ApiHttpError('GET', '/session', 403, 'Forbidden');
        vi.mocked(sendApiHttpRequest).mockRejectedValueOnce(denied);
        await expect(scheduledSessionHttpApi.read(ref, session, new AbortController().signal)).rejects.toBe(denied);
    });

    it('accepts successful creation without converting its void command result into an ambiguous failure', async () => {
        const create = vi.mocked(sendApiHttpRequest).mockResolvedValue(createGroupSnapshotFixture({ ...ref, sessionIds: [session.sessionId] }));
        await expect(
            scheduledSessionHttpApi.create({
                scope,
                request: { groupId: ref.groupId, requestId: 'scheduled-create-once-0001', displayName: 'Friday', startsAtEpochMs: 3_600_000, maxPlayers: 4 },
                session,
                signal: new AbortController().signal
            })
        )
            .resolves.toEqual(ref);
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ requestId: 'scheduled-create-once-0001' }) }));
    });

    it('accepts RSVP acknowledgement while preserving the stable request path', async () => {
        vi.mocked(sendApiHttpRequest).mockResolvedValue({ accepted: true });
        await expect(
            scheduledSessionHttpApi.change({
                ref,
                request: { requestId: 'scheduled-rsvp-once-0001', action: 'reserve', startsAtEpochMs: null, expectedScheduleRevision: 1 },
                session,
                signal: new AbortController().signal
            })
        )
            .resolves.toBeUndefined();
        expect(sendApiHttpRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                body: { action: 'reserve', startsAtEpochMs: null, expectedScheduleRevision: 1 },
                path: '/api/state/apps/game/workspaces/default/groups/scheduled/session/requests/scheduled-rsvp-once-0001'
            })
        );
    });
});
