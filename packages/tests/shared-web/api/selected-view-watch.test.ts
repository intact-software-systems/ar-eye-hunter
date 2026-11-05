import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { SelectedViewWatch } from '@shared-web/browser/api/selected-view-watch.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ViewWatchResult } from '@shared/api/views/view-watch.ts';
import { afterEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';

const session: AuthSession = {
    clientId: 'alice',
    sessionId: 'alice-session',
    username: 'alice',
    accessToken: 'test',
    expiresAtEpochMs: 9999999999999
};
const input: SelectedViewWatch.Selection = {
    session,
    resourceId: 'friday',
    connectionGenerationId: 'connection-1',
    signal: new AbortController().signal
};

function applied(call: SelectedViewWatch.ChangeInput): ViewWatchResult {
    return {
        status: 'applied',
        requestId: call.requestId,
        registrationId: call.request.resourceId === null ? null : call.requestId,
        resourceId: call.request.resourceId
    };
}

interface WatchFixture {
    readonly owner: SelectedViewWatch;
    readonly change: Mock<SelectedViewWatch.Dependencies['change']>;
}

function fixture(): WatchFixture {
    const change = vi.fn<SelectedViewWatch.Dependencies['change']>((call) => Promise.resolve(applied(call)));
    return { owner: new SelectedViewWatch({ change, createId: () => crypto.randomUUID() }), change };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('selected preview watch lifecycle', () => {
    it('awaits committed registration and reuses it until the selection or connection changes', async () => {
        const test = fixture();
        const answer = Promise.withResolvers<ViewWatchResult>();
        const started = Promise.withResolvers<SelectedViewWatch.ChangeInput>();
        test.change.mockImplementationOnce((call) => {
            started.resolve(call);
            return answer.promise;
        });
        let ready = false;
        const registering = test.owner.select(input).then(() => {
            ready = true;
        });
        const pending = await started.promise;
        expect(ready).toBe(false);
        answer.resolve(applied(pending));
        await registering;
        await test.owner.select(input);
        expect(test.change).toHaveBeenCalledOnce();
        await test.owner.select({ ...input, connectionGenerationId: 'connection-2' });
        expect(test.change).toHaveBeenCalledTimes(2);
    });

    it('learns an existing slot from conflict and makes a new conditional request identity', async () => {
        const test = fixture();
        test.change.mockImplementationOnce((call) =>
            Promise.resolve({
                status: 'conflict',
                requestId: call.requestId,
                registrationId: 'prior-owner',
                resourceId: 'old-room'
            })
        );
        await test.owner.select(input);
        const [first, second] = test.change.mock.calls.map(([call]) => call);
        expect(second!.request.expectedRegistrationId).toBe('prior-owner');
        expect(second!.requestId).not.toBe(first!.requestId);
        expect(second!.request.resourceId).toBe('friday');
    });

    it('reasserts the same target after a conflict and can clear a slot after an owner restart', async () => {
        const test = fixture();
        test.change.mockImplementationOnce((call) =>
            Promise.resolve({
                status: 'conflict',
                requestId: call.requestId,
                registrationId: 'prior-generation',
                resourceId: 'friday'
            })
        );
        await test.owner.select(input);
        const recovery = test.change.mock.calls.map(([call]) => call).find((call) => call.request.expectedRegistrationId === 'prior-generation');
        expect(recovery?.request.resourceId).toBe('friday');
        expect(recovery?.requestId).not.toBe(test.change.mock.calls[0]![0].requestId);
        await test.owner.release();
        expect(test.change).toHaveBeenCalledWith(
            expect.objectContaining({ request: expect.objectContaining({ resourceId: null, expectedRegistrationId: recovery!.requestId }) })
        );
        await test.owner.select({ ...input, resourceId: null });
        expect(test.change).toHaveBeenCalledWith(
            expect.objectContaining({ request: expect.objectContaining({ resourceId: null, expectedRegistrationId: null }) })
        );
    });

    it('retries uncertain registration with the same command identity and body', async () => {
        const test = fixture();
        test.change.mockRejectedValueOnce(new Error('Response lost'));
        await expect(test.owner.select(input)).rejects.toThrow('Response lost');
        await test.owner.select(input);
        const [first, second] = test.change.mock.calls.map(([call]) => call);
        expect(second!.requestId).toBe(first!.requestId);
        expect(second!.request).toEqual(first!.request);
    });

    it('does not follow a cleanup conflict and erase a replacement selection', async () => {
        const test = fixture();
        await test.owner.select(input);
        const registration = test.change.mock.calls[0]![0].requestId;
        test.change.mockImplementationOnce((call) =>
            Promise.resolve({
                status: 'conflict',
                requestId: call.requestId,
                registrationId: 'new-owner',
                resourceId: 'new-room'
            })
        );
        await test.owner.release();
        expect(test.change).toHaveBeenCalledTimes(2);
        expect(test.change.mock.calls[1]![0].request).toMatchObject({ resourceId: null, expectedRegistrationId: registration });
    });

    it.each([false, true])('replays an uncertain owned registration before cleanup (replacement=%s)', async (replacement) => {
        const test = fixture();
        if (replacement) {
            await test.owner.select({ ...input, resourceId: 'earlier' });
        }
        test.change.mockRejectedValueOnce(new Error('Committed response lost'));
        await expect(test.owner.select(input)).rejects.toThrow('Committed response lost');
        const uncertain = test.change.mock.calls.at(-1)![0];
        await test.owner.release();
        const calls = test.change.mock.calls.map(([call]) => call);
        expect(calls.at(-2)!.requestId).toBe(uncertain.requestId);
        expect(calls.at(-1)!.request).toMatchObject({ resourceId: null, expectedRegistrationId: uncertain.requestId });
    });

    it('never clears a foreign token learned during conflict backoff', async () => {
        vi.useFakeTimers();
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const test = fixture();
        test.change.mockImplementation((call) =>
            Promise.resolve({
                status: 'conflict',
                requestId: call.requestId,
                registrationId: 'another-owner',
                resourceId: 'another-room'
            })
        );
        const selecting = test.owner.select(input);
        await vi.advanceTimersByTimeAsync(0);
        const releasing = test.owner.release();
        await vi.advanceTimersByTimeAsync(1_000);
        await Promise.all([selecting, releasing]);
        expect(test.change).toHaveBeenCalledOnce();
    });

    it('new authentication does not wait for an obsolete pending registration', async () => {
        const test = fixture();
        const answer = Promise.withResolvers<ViewWatchResult>();
        const started = Promise.withResolvers<SelectedViewWatch.ChangeInput>();
        test.change.mockImplementationOnce((call) => {
            started.resolve(call);
            return answer.promise;
        });
        const old = test.owner.select(input);
        const pending = await started.promise;
        await test.owner.select({ ...input, session: { ...session, clientId: 'bob', sessionId: 'bob-session' } });
        expect(test.change.mock.calls[1]![0].session.clientId).toBe('bob');
        answer.resolve(applied(pending));
        await old;
        await test.owner.select({ ...input, session: { ...session, clientId: 'bob', sessionId: 'bob-session' } });
        expect(test.change).toHaveBeenCalledTimes(2);
    });

    // A refused replacement must not leave the earlier owned registration behind on the server.
    it('clears the owned registration when a replacement selection was refused', async () => {
        const test = fixture();
        await test.owner.select({ ...input, resourceId: 'earlier' });
        const owned = test.change.mock.calls[0]![0].requestId;
        test.change.mockRejectedValueOnce(new ApiHttpError('POST', '/view-watches', 403, 'denied'));
        await expect(test.owner.select(input)).rejects.toThrow();
        await test.owner.release();
        const calls = test.change.mock.calls.map(([call]) => call);
        expect(calls).toHaveLength(3);
        expect(calls[2]!.request).toMatchObject({ resourceId: null, expectedRegistrationId: owned });
    });

    it('still clears the owned registration when the uncertain replacement replay fails', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const test = fixture();
        await test.owner.select({ ...input, resourceId: 'earlier' });
        const owned = test.change.mock.calls[0]![0].requestId;
        test.change.mockRejectedValueOnce(new Error('Response lost')).mockRejectedValueOnce(new Error('Still lost'));
        await expect(test.owner.select(input)).rejects.toThrow('Response lost');
        await test.owner.release();
        const calls = test.change.mock.calls.map(([call]) => call);
        expect(calls[2]!.requestId).toBe(calls[1]!.requestId);
        expect(calls.at(-1)!.request).toMatchObject({ resourceId: null, expectedRegistrationId: owned });
    });

    it('uses a new command identity after a definitive refusal', async () => {
        const test = fixture();
        test.change.mockRejectedValueOnce(new ApiHttpError('POST', '/view-watches', 403, 'denied'));
        await expect(test.owner.select(input)).rejects.toThrow();
        await test.owner.select(input);
        const [refused, retried] = test.change.mock.calls.map(([call]) => call);
        expect(retried!.requestId).not.toBe(refused!.requestId);
    });
});
