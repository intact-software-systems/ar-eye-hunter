import { expect, it } from 'vitest';

import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';

it('owns each cleanup once and immediately cleans additions after closure', () => {
    const scope = new SubscriptionScope();
    const closed: string[] = [];
    const first = (): void => {
        closed.push('first');
    };
    scope.add(first).add(first).add(undefined).add(null);
    scope.add(() => {
        closed.push('second');
    });
    expect(scope.size()).toBe(2);
    scope.unsubscribe();
    scope.unsubscribe();
    scope.add(() => {
        closed.push('late');
    });
    expect(scope.size()).toBe(0);
    expect(closed).toEqual(['first', 'second', 'late']);
});

it('closes before invoking cleanup so reentrant unsubscribe cannot repeat it', () => {
    const scope = new SubscriptionScope();
    const closed: string[] = [];
    scope.add(() => {
        closed.push('first');
        scope.unsubscribe();
        scope.add(() => {
            closed.push('nested');
        });
    });
    scope.add(() => {
        closed.push('second');
    });
    scope.unsubscribe();
    expect(closed).toEqual(['first', 'nested', 'second']);
});

it('finishes cleanup after a failure and reports the collected failures', () => {
    const scope = new SubscriptionScope();
    const closed: string[] = [];
    scope.add(() => {
        throw new Error('cleanup failed');
    });
    scope.add(() => {
        closed.push('second');
    });
    expect(() => scope.unsubscribe()).toThrow(AggregateError);
    expect(closed).toEqual(['second']);
    expect(scope.size()).toBe(0);
    expect(() => scope.unsubscribe()).not.toThrow();
});
