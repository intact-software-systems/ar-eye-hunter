import type {
    RallarStateEventListener,
    RallarStateEventMessage
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarStateListener } from '@shared-web/browser/rallar-shared-contracts.ts';

export async function notifyStateEventListener<TEvent>(
    listener: RallarStateEventListener<TEvent>,
    event: TEvent,
    message: RallarStateEventMessage<TEvent>
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
