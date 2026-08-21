import { createRallarPeopleFacade } from '@shared-web/browser/rallar-people-facade.ts';
import type { RallarPeopleState, RallarPerson, RallarReplayEventsResult } from '@shared-web/browser/rallar.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import { describe, expect, it, vi } from 'vitest';

describe('Rallar people facade factory', () => {
    it('delegates people methods through injected operations', async () => {
        const state = {
            people: [],
            clients: []
        } satisfies RallarPeopleState;
        const person = {
            principalId: 'principal-1',
            username: 'user-1',
            isOnline: true,
            activeSessionCount: 1,
            activeSessionIds: ['session-1'],
            snapshot: {} as RallarPerson['snapshot']
        } satisfies RallarPerson;
        const event = {} as ClientEvent;
        const page = {
            events: [event],
            hasMore: false
        } as unknown as StateEventPage<ClientEvent>;
        const replay = {
            events: [event],
            hasMore: false,
            pageCount: 1,
            replayedCount: 1,
            duplicateCount: 0
        } satisfies RallarReplayEventsResult<ClientEvent>;
        const unsubscribe = vi.fn();
        const stateListener = vi.fn();
        const eventListener = vi.fn();
        const operations = {
            state: vi.fn(() => state),
            list: vi.fn(() => [person]),
            refresh: vi.fn(async () => state),
            listEvents: vi.fn(async () => [event]),
            listEventPage: vi.fn(async () => page),
            replayEvents: vi.fn(async () => replay),
            get: vi.fn(() => person),
            onChange: vi.fn(() => unsubscribe),
            onEvent: vi.fn(() => unsubscribe)
        };

        const facade = createRallarPeopleFacade(operations);

        expect(facade.state()).toBe(state);
        expect(facade.list()).toEqual([person]);
        await expect(
            facade.refresh({
                applicationId: 'app-1',
                workspaceId: 'workspace-1'
            })
        ).resolves.toBe(state);
        await expect(
            facade.listEvents('principal-1', { timeoutMs: 50 })
        ).resolves.toEqual([event]);
        await expect(
            facade.listEventPage('principal-1', { limit: 1 })
        ).resolves.toBe(page);
        await expect(
            facade.replayEvents(
                'principal-1',
                { maxPages: 1 },
                eventListener
            )
        ).resolves.toBe(replay);
        expect(facade.get('principal-1')).toBe(person);
        expect(facade.onChange(stateListener, { emitCurrent: false })).toBe(
            unsubscribe
        );
        expect(facade.onEvent(eventListener, {
            principalId: 'principal-1'
        })).toBe(unsubscribe);

        expect(operations.refresh).toHaveBeenCalledWith({
            applicationId: 'app-1',
            workspaceId: 'workspace-1'
        });
        expect(operations.listEvents).toHaveBeenCalledWith('principal-1', {
            timeoutMs: 50
        });
        expect(operations.listEventPage).toHaveBeenCalledWith('principal-1', {
            limit: 1
        });
        expect(operations.replayEvents).toHaveBeenCalledWith(
            'principal-1',
            { maxPages: 1 },
            eventListener
        );
        expect(operations.get).toHaveBeenCalledWith('principal-1');
        expect(operations.onChange).toHaveBeenCalledWith(stateListener, {
            emitCurrent: false
        });
        expect(operations.onEvent).toHaveBeenCalledWith(eventListener, {
            principalId: 'principal-1'
        });
    });
});
