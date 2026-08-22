import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

const RALLAR_WS_ANY_MESSAGE_CALLBACK_ID = 'rallar:ws:any-message';

export type RallarWsInboxHandler = Readonly<{
    id: string;
    order: number;
    onMessage(message: ALMessage): void | Promise<void>;
}>;

export type RallarWsInbox = Readonly<{
    subscribe(handler: RallarWsInboxHandler): RallarUnsubscribe;
    attach(ctx?: ApiMiddleware): void;
    detach(ctx?: ApiMiddleware): void;
    isAttached(): boolean;
}>;

export type CreateRallarWsInboxOptions = Readonly<{
    readMiddleware: () => ApiMiddleware | undefined;
}>;

export function createRallarWsInbox(
    options: CreateRallarWsInboxOptions
): RallarWsInbox {
    const handlers = new Map<string, RallarWsInboxHandler>();
    let attachedContext: ApiMiddleware | undefined;

    const dispatch = async (message: ALMessage): Promise<void> => {
        const ordered = [...handlers.values()].sort((left, right) => left.order - right.order);
        for (const handler of ordered) {
            await handler.onMessage(message);
        }
    };

    const attach = (ctx = options.readMiddleware()): void => {
        if (!ctx || attachedContext || handlers.size === 0) {
            return;
        }
        ctx.middleware.webSocketQueueBox.onAnyInboxMessageDo(
            RALLAR_WS_ANY_MESSAGE_CALLBACK_ID,
            { onMessage: dispatch }
        );
        attachedContext = ctx;
    };

    const detach = (ctx = attachedContext ?? options.readMiddleware()): void => {
        if (!attachedContext) {
            return;
        }
        ctx?.middleware.webSocketQueueBox.removeAnyInboxMessageCallback(
            RALLAR_WS_ANY_MESSAGE_CALLBACK_ID
        );
        attachedContext = undefined;
    };

    return {
        subscribe: (handler): RallarUnsubscribe => {
            if (handlers.has(handler.id)) {
                throw new Error(`Duplicate Rallar WS inbox handler: ${handler.id}`);
            }
            handlers.set(handler.id, handler);
            attach();
            return () => {
                handlers.delete(handler.id);
                if (handlers.size === 0) {
                    detach();
                }
            };
        },
        attach,
        detach,
        isAttached: (): boolean => attachedContext !== undefined
    };
}
