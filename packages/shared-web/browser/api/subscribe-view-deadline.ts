import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { scheduleAtDeadline } from '@shared/resilience/timing/schedule-at-deadline.ts';
import type { AuthenticatedResource } from './authenticated-resource.ts';

export namespace SubscribeViewDeadline {
    export interface Input<View> {
        readonly timers: Timers;
        onChange(listener: (state: Pick<AuthenticatedResource.State<View>, 'view'>) => void): () => void;
        remainingMs(view: View): number | null;
        refresh(): void | Promise<void>;
    }
}

/** Rechecks a time-derived view once; the owner selects its deadline from the server observation. */
export function subscribeViewDeadline<View>(input: SubscribeViewDeadline.Input<View>): () => void {
    const subscriptions = new SubscriptionScope();
    let observed: View | null = null;
    let cancelDeadline: (() => void) | null = null;
    subscriptions.add(input.onChange(({ view }) => {
        if (view === observed) {
            return;
        }
        observed = view;
        cancelDeadline?.();
        cancelDeadline = null;
        const remaining = view === null ? null : input.remainingMs(view);
        if (remaining !== null) {
            cancelDeadline = scheduleAtDeadline(input.timers, input.timers.nowMs() + remaining, input.refresh);
        }
    }));
    subscriptions.add(() => cancelDeadline?.());
    return () => subscriptions.unsubscribe();
}
