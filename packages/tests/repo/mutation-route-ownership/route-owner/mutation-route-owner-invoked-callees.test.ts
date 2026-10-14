import { readFileSync } from 'node:fs';
import {
    describe,
    expect,
    it
} from 'vitest';

import { MUTATION_ROUTE_INVENTORY, validateMutationRouteInventory } from '../routing/mutation-routing-inventory.ts';
import { readFlexibleAnchor } from './mutation-route-owner-anchors.ts';

describe.each([
    'enqueueClientSessionDisconnect',
    'enqueueGroupSessionCleanup'
])('%s executed lifecycle handoff', (enqueueMarker) => {
    const item = MUTATION_ROUTE_INVENTORY.find(
        (entry) => entry.transport === 'WS_LIFECYCLE' && entry.enqueueMarker === enqueueMarker
    );
    if (item === undefined) {
        throw new Error(`Lifecycle mutation route is absent: ${enqueueMarker}`);
    }
    const source = readFileSync(item.sourcePath, 'utf8');
    const live = readFlexibleAnchor(source, `(async () => await this.handlers.${enqueueMarker}(input))()`);
    const routeKey = `${item.transport}:${item.entrypoint}:${item.type}`;

    it.each(
        [
            ['async arrow invocation', '(async () => await this.handlers.HANDOFF(input))()', true],
            ['synchronous function invocation', '(function (handlers) { return handlers.HANDOFF(input); })(this.handlers)', true],
            ['stored then invoked async closure', '(() => { const later = async () => await this.handlers.HANDOFF(input); return later(); })()', true],
            [
                'stored async closure',
                '(() => { const stored = async () => await this.handlers.HANDOFF(input); void stored; return Promise.resolve(); })()',
                false
            ],
            ['uncalled function expression', '(function (handlers) { return handlers.HANDOFF(input); })', false]
        ] as const
    )('%s preserves executed handoff reachability', (_name, expression, connected) => {
        const replacement = expression.replaceAll('HANDOFF', enqueueMarker);
        const mutated = source.replace(live, replacement);
        const issues = validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
            sourceOverrides: new Map([[item.sourcePath, mutated]])
        }).filter((issue) => issue.startsWith(routeKey));

        expect(issues).toEqual(
            connected ? [] : [
                `${routeKey} registered handler is not connected to ${enqueueMarker} with AppInboxType.${item.type}`
            ]
        );
    });
});
