// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import { rallarCrdtBatch } from '@shared/crdt/mod.ts';

interface AuthoredTitle {
    readonly title: string;
}

describe('Rallar CRDT public caught-error boundaries', () => {
    it('refuses public open when applicationId and facade defaults are missing', async () => {
        const opening = createRallarFacade().crdt.open('missing-application-control', {
            persist: false,
            tabSync: false
        });

        await expect(opening).rejects.toBeInstanceOf(Error);
        await expect(opening).rejects.toMatchObject({
            message: 'Cannot open CRDT document: applicationId is required.'
        });
    });

    it.each([
        { scenario: 'primitive rejection', cause: 'application metric failed' },
        { scenario: 'existing Error rejection', cause: new Error('application metric failed') }
    ])('normalizes $scenario after a local application', async ({ cause }) => {
        const document = await createRallarFacade().crdt.open<AuthoredTitle>(
            'application-error-boundary',
            {
                applicationId: 'rallar-test',
                workspaceId: 'main',
                persist: false,
                tabSync: false,
                initialValue: { title: 'before application' },
                metrics: {
                    record: (event) => {
                        if (event.name === 'crdt.local.apply.ms') {
                            throw cause;
                        }
                    }
                }
            }
        );
        try {
            const batch = rallarCrdtBatch([
                { kind: 'register.set', path: ['title'], policy: 'lww', value: 'applied title' }
            ]);
            const caught = await document.applyLocal(batch).then(
                () => undefined,
                (error: unknown) => error
            );
            expect.soft(caught).toBeInstanceOf(Error);
            expect.soft(caught).toMatchObject({ message: 'application metric failed' });
            if (cause instanceof Error) {
                expect(caught).toBe(cause);
            }
            expect(document.failedPendingUpdates()).toEqual([
                expect.objectContaining({
                    reason: 'application metric failed',
                    update: expect.objectContaining({ payload: batch })
                })
            ]);
            expect(document.read()).toEqual({ title: 'applied title' });
        }
        finally {
            await document.close();
        }
    });

    it.each([
        { scenario: 'primitive rejection', cause: 'snapshot listener failed' },
        { scenario: 'existing Error rejection', cause: new Error('snapshot listener failed') }
    ])('normalizes $scenario at the snapshot listener logger', async ({ cause }) => {
        const document = await createRallarFacade().crdt.open<AuthoredTitle>(
            'listener-error-boundary',
            {
                applicationId: 'rallar-test',
                workspaceId: 'main',
                persist: false,
                tabSync: false,
                initialValue: { title: 'snapshot title' }
            }
        );
        const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const unsubscribe = document.subscribe(async (snapshot) => {
            expect(snapshot.value).toEqual({ title: 'snapshot title' });
            throw cause;
        });
        try {
            await vi.waitFor(() => expect(logger).toHaveBeenCalled());
            const loggedError: unknown = logger.mock.calls[0]?.[1];
            expect.soft(loggedError).toBeInstanceOf(Error);
            expect.soft(loggedError).toMatchObject({ message: 'snapshot listener failed' });
            if (cause instanceof Error) {
                expect(loggedError).toBe(cause);
            }
            expect(document.read()).toEqual({ title: 'snapshot title' });
        }
        finally {
            unsubscribe();
            try {
                await document.close();
            }
            finally {
                logger.mockRestore();
            }
        }
    });

    it('preserves ordinary local application and read success', async () => {
        const document = await createRallarFacade().crdt.open<AuthoredTitle>(
            'ordinary-error-boundary-control',
            {
                applicationId: 'rallar-test',
                workspaceId: 'main',
                persist: false,
                tabSync: false,
                initialValue: { title: 'before application' },
                metrics: { record: () => undefined }
            }
        );
        try {
            const batch = rallarCrdtBatch([
                { kind: 'register.set', path: ['title'], policy: 'lww', value: 'ordinary title' }
            ]);
            const update = await document.applyLocal(batch);

            expect(update.payload).toEqual(batch);
            expect(document.read()).toEqual({ title: 'ordinary title' });
            expect(document.failedPendingUpdates()).toEqual([]);
        }
        finally {
            await document.close();
        }
    });
});
