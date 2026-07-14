import type {
    RallarMessage,
    RallarStateEventListener,
    RallarStateListener,
    RallarSubscriptionScope,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar-facade-contract.ts';

export function createRallarSubscriptionScope(): RallarSubscriptionScope {
    const unsubscribers = new Set<RallarUnsubscribe>();
    let closed = false;
    let scope!: RallarSubscriptionScope;

    scope = {
        add: (unsubscribe): RallarSubscriptionScope => {
            if (!unsubscribe) {
                return scope;
            }

            if (closed) {
                unsubscribe();
                return scope;
            }

            unsubscribers.add(unsubscribe);
            return scope;
        },
        unsubscribe: (): void => {
            if (closed) {
                return;
            }

            closed = true;
            const current = [...unsubscribers];
            unsubscribers.clear();
            for (const unsubscribe of current) {
                unsubscribe();
            }
        },
        size: (): number => unsubscribers.size,
    };

    return scope;
}

export async function notifyStateEventListener<TEvent>(
    listener: RallarStateEventListener<TEvent>,
    event: TEvent,
    message: RallarMessage<TEvent>,
): Promise<void> {
    try {
        await listener(event, message);
    } catch (error) {
        console.error('Error notifying Rallar state event listener', error);
    }
}

export function notifyListener<T>(
    listener: RallarStateListener<T>,
    state: T,
): void {
    try {
        void Promise.resolve(listener(state)).catch((error) => {
            console.error('Error notifying Rallar state listener', error);
        });
    } catch (error) {
        console.error('Error notifying Rallar state listener', error);
    }
}
