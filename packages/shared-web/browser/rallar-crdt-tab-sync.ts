import type { RallarCrdtOperationBatch, RallarCrdtUpdateEnvelope } from '@shared/crdt/mod.ts';

export type RallarCrdtTabSync<TPayload extends RallarCrdtOperationBatch> = Readonly<{
    broadcast(update: RallarCrdtUpdateEnvelope<TPayload>): void;
    close(): void;
}>;

type RallarCrdtTabSyncMessage<TPayload extends RallarCrdtOperationBatch> = Readonly<{
    version: 1;
    documentKey: string;
    instanceId: string;
    update: RallarCrdtUpdateEnvelope<TPayload>;
}>;

export function createRallarCrdtTabSync<TPayload extends RallarCrdtOperationBatch>(
    options: Readonly<{
        documentKey: string;
        instanceId: string;
        onUpdate(
            update: RallarCrdtUpdateEnvelope<TPayload>
        ): void | Promise<void>;
    }>
): RallarCrdtTabSync<TPayload> {
    if (typeof BroadcastChannel === 'undefined') {
        return {
            broadcast: () => {},
            close: () => {}
        };
    }

    const channel = new BroadcastChannel(`rallar-crdt:${options.documentKey}`);
    channel.onmessage = (event: MessageEvent) => {
        const message = event.data as Partial<RallarCrdtTabSyncMessage<TPayload>>;
        if (
            message.version !== 1 ||
            message.documentKey !== options.documentKey ||
            message.instanceId === options.instanceId ||
            !message.update
        ) {
            return;
        }

        void Promise.resolve(options.onUpdate(message.update)).catch(
            (error) => {
                console.error('Error applying CRDT tab-sync update', error);
            }
        );
    };

    return {
        broadcast: (update): void => {
            channel.postMessage(
                {
                    version: 1,
                    documentKey: options.documentKey,
                    instanceId: options.instanceId,
                    update
                } satisfies RallarCrdtTabSyncMessage<TPayload>
            );
        },
        close: (): void => {
            channel.close();
        }
    };
}
