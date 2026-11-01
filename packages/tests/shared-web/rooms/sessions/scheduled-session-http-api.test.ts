import { sendApiHttpRequest } from '@shared-web/browser/api/send-api-http-request.ts';
import { scheduledSessionHttpApi } from '@shared-web/browser/rooms/sessions/scheduled-session-http-api.ts';
import { describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from '../../authoritative-group-fixtures.ts';

vi.mock('@shared-web/browser/api-client-config.ts', () => ({ readApiBaseUrl: () => 'http://api.test' }));
vi.mock('@shared-web/browser/api/send-api-http-request.ts', () => ({ sendApiHttpRequest: vi.fn() }));
const scope = { applicationId: 'game', workspaceId: 'default' };
const ref = { ...scope, groupId: 'scheduled' };
const session = { clientId: 'alice', sessionId: 'alice-session', username: 'alice', accessToken: 'test', expiresAtEpochMs: 9_999_999_999_999 };

describe('scheduled-session HTTP acknowledgement', () => {
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
