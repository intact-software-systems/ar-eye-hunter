import { describe, expect, it } from 'vitest';
import {
    RECIPE_CONSOLE_SENSITIVE_URL_KEYS,
} from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';
import {
    createRecipeConsoleUrlHistory,
    type RecipeConsoleHistoryPort,
} from '../../../apps/rallar-black-box/src/recipe-console/routing/url-history.ts';

class MemoryHistoryPort implements RecipeConsoleHistoryPort {
    currentSearch: string;
    readonly pushed: string[] = [];
    readonly replaced: string[] = [];
    private readonly listeners = new Set<() => void>();

    constructor(search: string) {
        this.currentSearch = search;
    }

    readSearch(): string {
        return this.currentSearch;
    }

    push(search: string): void {
        this.currentSearch = search;
        this.pushed.push(search);
    }

    replace(search: string): void {
        this.currentSearch = search;
        this.replaced.push(search);
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emitPopState(search: string): void {
        this.currentSearch = search;
        for (const listener of this.listeners) {
            listener();
        }
    }
}

function sensitiveSearch(): string {
    const params = new URLSearchParams({
        provider: 'simulated',
        v: '1',
        experience: 'recipe-console',
        view: 'execute',
    });
    for (const key of RECIPE_CONSOLE_SENSITIVE_URL_KEYS) {
        params.append(key.toUpperCase(), `secret-${key}`);
    }
    return `?${params.toString()}`;
}

function expectNoSensitiveKeys(search: string): void {
    const sensitive = new Set(RECIPE_CONSOLE_SENSITIVE_URL_KEYS.map(key => key.toLowerCase()));
    expect(
        [...new URLSearchParams(search).keys()]
            .filter(key => sensitive.has(key.toLowerCase())),
    ).toEqual([]);
}

describe('Recipe Console URL history', () => {
    it('pushes committed patches while preserving safe unknown state', () => {
        const port = new MemoryHistoryPort(
            '?provider=simulated&roomId=room-a&workspace=black-box-runner' +
            '&v=1&experience=recipe-console&view=execute',
        );
        const history = createRecipeConsoleUrlHistory(port);

        const next = history.push({
            view: 'monitor',
            controlRunId: 'run-a',
        });

        expect(port.pushed).toHaveLength(1);
        expect(port.replaced).toHaveLength(0);
        expect(next.state).toMatchObject({ view: 'monitor', controlRunId: 'run-a' });
        const params = new URLSearchParams(port.pushed[0]);
        expect(params.get('provider')).toBe('simulated');
        expect(params.get('roomId')).toBe('room-a');
        expect(params.has('workspace')).toBe(false);
    });

    it('replaces high-frequency patches without creating a push entry', () => {
        const port = new MemoryHistoryPort(
            '?future=value&v=1&experience=recipe-console&view=tune&from=100&to=200',
        );
        const history = createRecipeConsoleUrlHistory(port);

        const next = history.replace({ from: 300, to: 600 });

        expect(port.pushed).toHaveLength(0);
        expect(port.replaced).toHaveLength(1);
        expect(next.state).toMatchObject({ view: 'tune', from: 300, to: 600 });
        expect(new URLSearchParams(port.replaced[0]).get('future')).toBe('value');
    });

    it('scrubs every sensitive query key during push and replace', () => {
        const port = new MemoryHistoryPort(sensitiveSearch());
        const history = createRecipeConsoleUrlHistory(port);

        history.push({ view: 'monitor' });
        expectNoSensitiveKeys(port.pushed[0]);
        expect(port.pushed[0]).toContain('provider=simulated');

        port.currentSearch = sensitiveSearch();
        history.replace({ view: 'analyze' });
        expectNoSensitiveKeys(port.replaced[0]);
        expect(port.replaced[0]).toContain('provider=simulated');
    });

    it('restores complete validated state on popstate without writing history', () => {
        const port = new MemoryHistoryPort(
            '?v=1&experience=recipe-console&view=execute',
        );
        const history = createRecipeConsoleUrlHistory(port);
        const received: string[] = [];
        const unsubscribe = history.subscribe(value => {
            received.push(
                `${value.state.view}:${value.state.controlRunId ?? ''}:${value.state.from ?? ''}`,
            );
        });

        port.emitPopState(
            '?v=1&experience=recipe-console&view=monitor&controlRunId=run-b&from=100',
        );

        expect(received).toEqual(['monitor:run-b:100']);
        expect(port.pushed).toEqual([]);
        expect(port.replaced).toEqual([]);

        unsubscribe();
        port.emitPopState('?v=1&experience=recipe-console&view=fleet');
        expect(received).toEqual(['monitor:run-b:100']);
    });
});
