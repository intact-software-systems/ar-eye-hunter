import type { RallarMessage, RallarStateEventListener } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type {
    RallarStateListener,
    RallarSubscriptionScope,
    RallarUnsubscribe
} from '@shared-web/browser/rallar-shared-contracts.ts';

export class BrowserRallarSubscriptionScope implements RallarSubscriptionScope {
    private readonly unsubscribers = new Set<RallarUnsubscribe>();
    private closed = false;

    add(unsubscribe?: RallarUnsubscribe): RallarSubscriptionScope {
        if (!unsubscribe) {
            return this;
        }

        if (this.closed) {
            unsubscribe();
            return this;
        }

        this.unsubscribers.add(unsubscribe);
        return this;
    }

    unsubscribe(): void {
        if (this.closed) {
            return;
        }

        this.closed = true;
        const current = [...this.unsubscribers];
        this.unsubscribers.clear();
        for (const unsubscribe of current) {
            unsubscribe();
        }
    }

    size(): number {
        return this.unsubscribers.size;
    }
}

export async function notifyStateEventListener<TEvent>(
    listener: RallarStateEventListener<TEvent>,
    event: TEvent,
    message: RallarMessage<TEvent>
): Promise<void> {
    try {
        await listener(event, message);
    }
    catch (error) {
        console.error('Error notifying Rallar state event listener', error);
    }
}

export function notifyListener<T>(
    listener: RallarStateListener<T>,
    state: T
): void {
    try {
        void Promise.resolve(listener(state)).catch((error) => {
            console.error('Error notifying Rallar state listener', error);
        });
    }
    catch (error) {
        console.error('Error notifying Rallar state listener', error);
    }
}
