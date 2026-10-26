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

    it('isolates synchronous replay failure and returns a usable unsubscribe handle', async () => {
        const document = await createRallarFacade().crdt.open<AuthoredTitle>(
            'synchronous-replay-failure',
            {
                applicationId: 'rallar-test',
                workspaceId: 'main',
                persist: false,
                tabSync: false,
                initialValue: { title: 'initial' }
            }
        );
        const logged: Error[] = [];
        const logger = vi.spyOn(console, 'error').mockImplementation((_message, error: Error) => {
            logged.push(error);
        });
        try {
            const unsubscribe = document.subscribe(() => {
                throw new Error('synchronous replay failed');
            });
            unsubscribe();
            await document.applyLocal(rallarCrdtBatch([
                { kind: 'register.set', path: ['title'], policy: 'lww', value: 'updated' }
            ]));
            expect(document.read()).toEqual({ title: 'updated' });
            expect(logged.map((error) => error.message)).toEqual(['synchronous replay failed']);
        }
        finally {
            await document.close();
            logger.mockRestore();
        }
    });

    it('keeps an applied update successful when a synchronous observer fails', async () => {
        const document = await createRallarFacade().crdt.open<AuthoredTitle>(
            'synchronous-publication-failure',
            {
                applicationId: 'rallar-test',
                workspaceId: 'main',
                persist: false,
                tabSync: false,
                initialValue: { title: 'initial' }
            }
        );
        const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const observed: string[] = [];
        document.subscribe((snapshot) => {
            if (snapshot.value.title === 'updated') {
                throw new Error('publication observer failed');
            }
        });
        document.subscribe((snapshot) => {
            observed.push(snapshot.value.title);
        });
        try {
            const payload = rallarCrdtBatch([
                { kind: 'register.set', path: ['title'], policy: 'lww', value: 'updated' }
            ]);
            await expect(document.applyLocal(payload)).resolves.toMatchObject({ payload });
            expect(document.read()).toEqual({ title: 'updated' });
            expect(document.failedPendingUpdates()).toEqual([]);
            expect(observed).toEqual(['initial', 'updated']);
        }
        finally {
            await document.close();
            logger.mockRestore();
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
