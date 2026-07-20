import { describe, expect, it, vi } from 'vitest';
import {
    installRallarGameAuthorityServer,
    type RallarGameAuthorityServerRallarFacade,
} from '@shared-server/game/authority-server.ts';
import {
    createRallarGameAuthorityEnvelope,
    type RallarGameAuthorityEnvelope,
    type RallarGameAuthorityRef,
} from '@shared/rallar-game/mod.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RallarServerWsMessage,
    RallarServerWsMessageContext,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition,
} from '@shared-server/rallar-facade/ws-topic-router.ts';

type Command = Readonly<{ action: string }>;
type Snapshot = Readonly<{ tick: number }>;
type Event = Readonly<{ kind: string }>;

const roomRef: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1',
};

const authority: RallarGameAuthorityRef = {
    kind: 'server',
    id: 'server-1',
    epoch: 1,
};

describe('Rallar Game Authority server installer', () => {
    it('defines command and sync-request topics with no fanout', async () => {
        const fake = createFakeServerRallar();

        installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            handleCommand: async () => ({ status: 'accepted' }),
        });

        expect(fake.definitions).toMatchObject([
            {
                topicId: 'game.authority',
                typeId: 'game.authority.command.v1',
                scope: 'room',
                fanout: 'none',
            },
            {
                topicId: 'game.authority',
                typeId: 'game.authority.sync-request.v1',
                scope: 'room',
                fanout: 'none',
            },
        ]);

        const commandDefinition = fake.definition('game.authority.command.v1');
        expect(
            await commandDefinition.validate?.(
                envelope('command', 'peer-a', { action: 'move' }, 1),
                fake.context('peer-a'),
            ),
        ).toBe(true);
        expect(
            await commandDefinition.validate?.(
                {
                    ...envelope('command', 'peer-a', { action: 'move' }, 1),
                    senderId: 'peer-b',
                },
                fake.context('peer-a'),
            ),
        ).toBe(false);
    });

    it('rejects invalid command envelopes before app handlers run', async () => {
        const fake = createFakeServerRallar();
        const handleCommand = vi.fn(async () => ({ status: 'accepted' as const }));
        installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            handleCommand,
        });

        await fake.emit(
            'game.authority.command.v1',
            'peer-a',
            {
                ...envelope('command', 'peer-a', { action: 'move' }, 1),
                protocol: 'wrong.protocol',
            },
        );

        expect(handleCommand).not.toHaveBeenCalled();
        expect(fake.published).toHaveLength(0);
    });

    it('calls app command handler and publishes snapshots and events for accepted commands', async () => {
        const fake = createFakeServerRallar();
        const handleCommand = vi.fn(async () => ({
            status: 'accepted' as const,
            snapshot: { tick: 7 },
            events: [{ kind: 'cash-picked' }, { kind: 'score-changed' }],
        }));
        const server = installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            handleCommand,
        });

        await fake.emit(
            'game.authority.command.v1',
            'peer-a',
            envelope('command', 'peer-a', { action: 'move' }, 1),
        );

        expect(handleCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                command: { action: 'move' },
                roomId: 'room-1',
                senderId: 'peer-a',
            }),
        );
        expect(fake.published.map((entry) => parseEnvelope(entry.message).kind))
            .toEqual(['command-result', 'snapshot', 'event', 'event']);
        expect(parseEnvelope(fake.published[0].message).payload).toEqual({
            commandSeq: 1,
            status: 'accepted',
        });
        expect(parseEnvelope(fake.published[1].message).payload).toEqual({
            tick: 7,
        });
        expect(fake.published[0].message.targets).toEqual({
            mode: 'unicast',
            toPeerId: 'peer-a',
        });
        expect(fake.published[1].message.targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
            groupRef: roomRef,
        });
        expect(server.status()).toMatchObject({
            handledCommandCount: 1,
            rejectedCommandCount: 0,
            publishedSnapshotCount: 1,
            publishedEventCount: 2,
        });
    });

    it('publishes only command-result for rejected commands', async () => {
        const fake = createFakeServerRallar();
        installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            handleCommand: async () => ({
                status: 'rejected',
                reason: 'illegal-command',
                snapshot: { tick: 999 },
                events: [{ kind: 'should-not-publish' }],
            }),
        });

        await fake.emit(
            'game.authority.command.v1',
            'peer-a',
            envelope('command', 'peer-a', { action: 'cheat' }, 1),
        );

        expect(fake.published).toHaveLength(1);
        expect(parseEnvelope(fake.published[0].message)).toMatchObject({
            kind: 'command-result',
            payload: {
                commandSeq: 1,
                status: 'rejected',
                reason: 'illegal-command',
            },
        });
    });

    it('unicasts readSnapshot result to sync-request sender', async () => {
        const fake = createFakeServerRallar();
        const readSnapshot = vi.fn(async () => ({ tick: 42 }));
        installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            handleCommand: async () => ({ status: 'accepted' }),
            readSnapshot,
        });

        await fake.emit(
            'game.authority.sync-request.v1',
            'peer-a',
            envelope('sync-request', 'peer-a', { reason: 'late-join' }, 1),
        );

        expect(readSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({
                payload: { reason: 'late-join' },
                roomId: 'room-1',
                senderId: 'peer-a',
            }),
        );
        expect(fake.published).toHaveLength(1);
        expect(parseEnvelope(fake.published[0].message)).toMatchObject({
            kind: 'snapshot',
            payload: { tick: 42 },
        });
        expect(fake.published[0].message.targets).toEqual({
            mode: 'unicast',
            toPeerId: 'peer-a',
        });
    });

    it('unsubscribes handlers and prevents later command handling on stop', async () => {
        const fake = createFakeServerRallar();
        const handleCommand = vi.fn(async () => ({ status: 'accepted' as const }));
        const server = installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            handleCommand,
        });

        server.stop();
        await fake.emit(
            'game.authority.command.v1',
            'peer-a',
            envelope('command', 'peer-a', { action: 'late' }, 1),
        );

        expect(handleCommand).not.toHaveBeenCalled();
        expect(fake.handlers).toHaveLength(0);
        expect(server.status().stopped).toBe(true);
    });
});

function envelope<T>(
    kind: RallarGameAuthorityEnvelope<T>['kind'],
    senderId: string,
    payload: T,
    seq: number,
): RallarGameAuthorityEnvelope<T> {
    return createRallarGameAuthorityEnvelope({
        protocol: 'test.authority.v1',
        kind,
        roomId: 'room-1',
        senderId,
        seq,
        sentAtEpochMs: 1_000 + seq,
        authority,
        payload,
    });
}

function createFakeServerRallar() {
    const definitions: RallarServerWsTopicDefinition<unknown>[] = [];
    const handlers: HandlerSubscription[] = [];
    const published: Array<{ message: ALMessage; fanout?: string }> = [];
    const ws = {
        defineTopic: vi.fn((definition: RallarServerWsTopicDefinition<unknown>) => {
            definitions.push(definition);
            return definition;
        }),
        on: vi.fn((
            selector: RallarServerWsSelector,
            handler: HandlerSubscription['handler'],
        ) => {
            const subscription = { selector, handler };
            handlers.push(subscription);
            return () => {
                remove(handlers, subscription);
                return true;
            };
        }),
        publish: vi.fn(async (message: ALMessage, fanout?: string) => {
            published.push({ message, fanout });
            return {
                fanout: fanout ?? 'live-only',
                status: 'sent-live' as const,
                message,
                sentCount: 1,
                recipientCount: 1,
                failedCount: 0,
                entries: [],
            };
        }),
    };

    return {
        definitions,
        handlers,
        published,
        ws,
        rallar: { ws } as unknown as RallarGameAuthorityServerRallarFacade,
        definition(typeId: string) {
            const definition = definitions.find((candidate) =>
                candidate.typeId === typeId
            );
            if (!definition) {
                throw new Error(`Missing definition for ${typeId}`);
            }
            return definition;
        },
        context(senderId: string): RallarServerWsMessageContext<unknown> {
            return {
                service: {} as RallarServerWsMessageContext<unknown>['service'],
                definition: definitions[0],
                roomId: 'room-1',
                roomRef,
                senderId,
                proxy: {} as RallarServerWsMessageContext<unknown>['proxy'],
            };
        },
        async emit<T>(
            typeId: string,
            senderId: string,
            payload: RallarGameAuthorityEnvelope<T>,
        ) {
            const message: RallarServerWsMessage<RallarGameAuthorityEnvelope<T>> = {
                payload,
                raw: {} as ALMessage,
                receivedAtEpochMs: Date.now(),
            };
            const context = this.context(senderId) as RallarServerWsMessageContext<
                RallarGameAuthorityEnvelope<T>
            >;
            await Promise.all(
                handlers
                    .filter((subscription) =>
                        subscription.selector.topicId === 'game.authority' &&
                        subscription.selector.typeId === typeId
                    )
                    .map((subscription) => Reflect.apply(
                        subscription.handler,
                        undefined,
                        [message, context],
                    )),
            );
        },
    };
}

type HandlerSubscription = Readonly<{
    selector: RallarServerWsSelector;
    handler: (
        message: RallarServerWsMessage<unknown>,
        context: RallarServerWsMessageContext<unknown>,
    ) => void | Promise<void>;
}>;

function parseEnvelope(message: ALMessage): RallarGameAuthorityEnvelope<unknown> {
    return JSON.parse(message.payload.resource) as RallarGameAuthorityEnvelope<unknown>;
}

function remove<T>(values: T[], value: T): void {
    const index = values.indexOf(value);
    if (index >= 0) {
        values.splice(index, 1);
    }
}
