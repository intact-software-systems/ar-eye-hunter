import { describe, expect, it } from 'vitest';
import { recipeConsoleExecuteRecipeSelectionPatch } from '../../../apps/rallar-black-box/src/recipe-console/execute/execute-workflow-state.ts';
import { createRecipeConsoleUrlHistory, type RecipeConsoleHistoryPort } from '../../../apps/rallar-black-box/src/recipe-console/routing/url-history.ts';
import { RECIPE_CONSOLE_SENSITIVE_URL_KEYS } from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';

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
        view: 'execute'
    });
    for (const key of RECIPE_CONSOLE_SENSITIVE_URL_KEYS) {
        params.append(key.toUpperCase(), `secret-${key}`);
    }
    return `?${params.toString()}`;
}

function expectNoSensitiveKeys(search: string): void {
    const sensitive = new Set(RECIPE_CONSOLE_SENSITIVE_URL_KEYS.map((key) => key.toLowerCase()));
    expect(
        [...new URLSearchParams(search).keys()]
            .filter((key) => sensitive.has(key.toLowerCase()))
    ).toEqual([]);
}

describe('Recipe Console URL history', () => {
    it('commits History Apply and Reset as one push each without clearing unrelated state', () => {
        const port = new MemoryHistoryPort(
            '?provider=simulated&futureField=keep&v=1&experience=recipe-console&view=tune' +
                '&recipeId=operational-recipe&compareLeft=baseline-a&compareRight=candidate-a' +
                '&timingMetric=stream-cadence'
        );
        const history = createRecipeConsoleUrlHistory(port);

        const applied = history.push({
            historyQuery: 'failed ack',
            historyGroup: 'bb-group',
            historyRecipeId: 'history-recipe',
            historyProfile: 'smoke',
            failureCategory: 'readiness',
            status: 'failed',
            from: 100,
            to: 900
        });

        expect(port.pushed).toHaveLength(1);
        expect(applied.state).toMatchObject({
            recipeId: 'operational-recipe',
            historyQuery: 'failed ack',
            historyGroup: 'bb-group',
            historyRecipeId: 'history-recipe',
            historyProfile: 'smoke',
            failureCategory: 'readiness',
            compareLeft: 'baseline-a',
            compareRight: 'candidate-a',
            timingMetric: 'stream-cadence'
        });

        const reset = history.push({
            historyQuery: undefined,
            historyGroup: undefined,
            historyRecipeId: undefined,
            historyProfile: undefined,
            failureCategory: undefined,
            status: undefined,
            from: undefined,
            to: undefined
        });

        expect(port.pushed).toHaveLength(2);
        for (
            const field of [
                'historyQuery',
                'historyGroup',
                'historyRecipeId',
                'historyProfile',
                'failureCategory',
                'status',
                'from',
                'to'
            ]
        ) {
            expect(new URLSearchParams(port.pushed[1]).has(field), field).toBe(false);
        }
        expect(reset.state).toMatchObject({
            recipeId: 'operational-recipe',
            compareLeft: 'baseline-a',
            compareRight: 'candidate-a',
            timingMetric: 'stream-cadence'
        });
        expect(new URLSearchParams(port.pushed[1]).get('provider')).toBe('simulated');
        expect(new URLSearchParams(port.pushed[1]).get('futureField')).toBe('keep');
    });

    it('changes operational recipe selection independently from the History recipe filter', () => {
        const port = new MemoryHistoryPort(
            '?v=1&experience=recipe-console&view=tune' +
                '&recipeId=operational-a&historyRecipeId=history-recipe'
        );
        const history = createRecipeConsoleUrlHistory(port);

        const selected = history.push({ recipeId: 'operational-b' });
        expect(selected.state).toMatchObject({
            recipeId: 'operational-b',
            historyRecipeId: 'history-recipe'
        });

        const cleared = history.push({ recipeId: undefined });
        expect(cleared.state.recipeId).toBeUndefined();
        expect(cleared.state.historyRecipeId).toBe('history-recipe');
    });

    it('pushes recipe selection while removing dependent run and command keys', () => {
        const port = new MemoryHistoryPort(
            '?v=1&experience=recipe-console&view=execute&controlRunId=run-a' +
                '&distributedRunId=distributed-a&commandId=command-a&recipeId=recipe-a'
        );
        const history = createRecipeConsoleUrlHistory(port);

        const next = history.push(
            recipeConsoleExecuteRecipeSelectionPatch('recipe-b')
        );

        expect(next.state).toMatchObject({
            controlRunId: 'run-a',
            recipeId: 'recipe-b'
        });
        expect(next.state.distributedRunId).toBeUndefined();
        expect(next.state.commandId).toBeUndefined();
        const params = new URLSearchParams(port.pushed[0]);
        expect(params.has('distributedRunId')).toBe(false);
        expect(params.has('commandId')).toBe(false);
    });

    it('pushes committed patches while preserving safe unknown state', () => {
        const port = new MemoryHistoryPort(
            '?provider=simulated&roomId=room-a&workspace=black-box-runner' +
                '&v=1&experience=recipe-console&view=execute'
        );
        const history = createRecipeConsoleUrlHistory(port);

        const next = history.push({
            view: 'monitor',
            controlRunId: 'run-a'
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
            '?future=value&v=1&experience=recipe-console&view=tune&from=100&to=200'
        );
        const history = createRecipeConsoleUrlHistory(port);

        const next = history.replace({ from: 300, to: 600 });

        expect(port.pushed).toHaveLength(0);
        expect(port.replaced).toHaveLength(1);
        expect(next.state).toMatchObject({ view: 'tune', from: 300, to: 600 });
        expect(new URLSearchParams(port.replaced[0]).get('future')).toBe('value');
    });

    it('does not write an idempotent replacement', () => {
        const port = new MemoryHistoryPort(
            '?v=1&experience=recipe-console&view=execute&recipeId=recipe-a'
        );
        const history = createRecipeConsoleUrlHistory(port);

        const next = history.replace({ recipeId: 'recipe-a' });

        expect(next.state.recipeId).toBe('recipe-a');
        expect(port.replaced).toEqual([]);
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
            '?v=1&experience=recipe-console&view=execute'
        );
        const history = createRecipeConsoleUrlHistory(port);
        const received: Array<
            Readonly<{
                view: string;
                historyRecipeId?: string;
                failureCategory?: string;
                recipeId?: string;
                compareLeft?: string;
                timingMetric?: string;
            }>
        > = [];
        const unsubscribe = history.subscribe((value) => {
            received.push({
                view: value.state.view,
                historyRecipeId: value.state.historyRecipeId,
                failureCategory: value.state.failureCategory,
                recipeId: value.state.recipeId,
                compareLeft: value.state.compareLeft,
                timingMetric: value.state.timingMetric
            });
        });

        port.emitPopState(
            '?provider=simulated&futureField=keep&v=1&experience=recipe-console&view=tune' +
                '&historyRecipeId=history-recipe&failureCategory=barrier' +
                '&recipeId=operational-recipe&compareLeft=baseline-a' +
                '&timingMetric=stream-drift'
        );

        expect(received).toEqual([{
            view: 'tune',
            historyRecipeId: 'history-recipe',
            failureCategory: 'barrier',
            recipeId: 'operational-recipe',
            compareLeft: 'baseline-a',
            timingMetric: 'stream-drift'
        }]);
        expect(port.pushed).toEqual([]);
        expect(port.replaced).toEqual([]);

        unsubscribe();
        port.emitPopState('?v=1&experience=recipe-console&view=fleet');
        expect(received).toHaveLength(1);
    });
});
