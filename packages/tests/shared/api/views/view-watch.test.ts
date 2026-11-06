import { decodeViewWatchFamily, decodeViewWatchRequest, decodeViewWatchResult, VIEW_WATCH_FAMILIES } from '@shared/api/views/view-watch.ts';
import { expect, it } from 'vitest';

it('keeps watch mutation authority out of the client body and accepts a fenced clear', () => {
    const request = { resourceId: null, connectionGenerationId: 'generation', expectedRegistrationId: 'old-request' };
    expect(decodeViewWatchRequest(request)).toEqual(request);
    expect(() => decodeViewWatchRequest({ ...request, principalId: 'other' })).toThrow();
    expect(() => decodeViewWatchRequest({ ...request, expectedRegistrationId: undefined })).toThrow();
});

it('decodes an exact conflicting predecessor and rejects incomplete registrations', () => {
    const result = { status: 'conflict', requestId: 'attempt', registrationId: 'current', resourceId: 'group' };
    expect(decodeViewWatchResult(result)).toEqual(result);
    expect(() => decodeViewWatchResult({ ...result, registrationId: null })).toThrow();
    expect(() => decodeViewWatchResult({ ...result, status: 'accepted' })).toThrow();
});

it('uses one closed watch family inventory and keeps family out of command data', () => {
    expect(VIEW_WATCH_FAMILIES.map(decodeViewWatchFamily)).toEqual(['session-preview', 'tournament']);
    expect(() => decodeViewWatchFamily('arbitrary-owner')).toThrow();
    expect(() => decodeViewWatchRequest({ resourceId: 'selected', connectionGenerationId: 'generation', expectedRegistrationId: null, family: 'tournament' }))
        .toThrow();
});
