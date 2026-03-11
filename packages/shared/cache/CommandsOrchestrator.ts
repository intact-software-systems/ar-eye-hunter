import { Command, type CommandOptions, type LoanedValueSupplier, } from './Command.ts';
import { LoanedValue } from './LoanedValue.ts';
import { LoanedRepository } from './LoanedRepository.ts';

export type OrchestratorResults<K, V> = ReadonlyMap<K, V>;
export type OrchestratorMutableResults<K, V> = Map<K, V>;

export type OrchestratorEntry<K, V> = readonly [K, V];

export type OrchestratorStep<K, V> = (
    results: OrchestratorResults<K, V>,
) => Promise<OrchestratorEntry<K, V>>;

export interface CommandsOrchestratorPolicies<V> {
    command?: CommandOptions<V>;
}

type PhaseMode = 'sequential' | 'parallel';

type Phase<K, V> = {
    mode: PhaseMode;
    steps: Array<OrchestratorStep<K, V>>;
};

export class CommandsOrchestrator<K, V> {
    private readonly phases: Array<Phase<K, V>> = [];
    private readonly afterPhaseCallbacks: Array<
        (results: OrchestratorResults<K, V>) => void | Promise<void>
    > = [];
    private readonly policies: CommandsOrchestratorPolicies<V>;

    private constructor(
        policies: CommandsOrchestratorPolicies<V> = {},
    ) {
        this.policies = policies;
    }

    public static withPolicies<K, V>(
        policies: CommandsOrchestratorPolicies<V> = {},
    ): CommandsOrchestrator<K, V> {
        return new CommandsOrchestrator<K, V>(policies);
    }

    /**
     * Starts a new sequential phase.
     */
    public sequential(
        ...steps: Array<OrchestratorStep<K, V>>
    ): this {
        this.phases.push({
            mode: 'sequential',
            steps: [...steps],
        });
        return this;
    }

    /**
     * Starts a new parallel phase.
     */
    public parallel(
        ...steps: Array<OrchestratorStep<K, V>>
    ): this {
        this.phases.push({
            mode: 'parallel',
            steps: [...steps],
        });
        return this;
    }

    /**
     * Runs a callback after the phases defined so far.
     * The callback can inspect the accumulated results.
     */
    public then(
        callback: (results: OrchestratorResults<K, V>) => void | Promise<void>,
    ): this {
        this.afterPhaseCallbacks.push(callback);
        return this;
    }

    /**
     * Executes the built orchestration and returns the final result map.
     */
    public async run(): Promise<Map<K, V>> {
        const results: OrchestratorMutableResults<K, V> = new Map();

        for (let phaseIndex = 0; phaseIndex < this.phases.length; phaseIndex++) {
            const phase = this.phases[phaseIndex];

            if (phase.mode === 'sequential') {
                await this.runSequentialPhase(phase, results);
            } else {
                await this.runParallelPhase(phase, results);
            }

            if (phaseIndex < this.afterPhaseCallbacks.length) {
                await this.afterPhaseCallbacks[phaseIndex](results);
            }
        }

        for (let i = this.phases.length; i < this.afterPhaseCallbacks.length; i++) {
            await this.afterPhaseCallbacks[i](results);
        }

        return results;
    }

    private async runSequentialPhase(
        phase: Phase<K, V>,
        results: OrchestratorMutableResults<K, V>,
    ): Promise<void> {
        for (const step of phase.steps) {
            const [key, value] = await step(results);
            results.set(key, value);
        }
    }

    private async runParallelPhase(
        phase: Phase<K, V>,
        results: OrchestratorMutableResults<K, V>,
    ): Promise<void> {
        const snapshot = new Map(results);
        const entries = await Promise.all(
            phase.steps.map((step) => step(snapshot)),
        );

        for (const [key, value] of entries) {
            results.set(key, value);
        }
    }

    // -------------------------------------------------------
    // Step factories
    // -------------------------------------------------------

    public commandStep(
        key: K,
        supplier: LoanedValueSupplier<V>,
        options?: CommandOptions<V>,
    ): OrchestratorStep<K, V> {
        const mergedOptions: CommandOptions<V> = {
            ...this.policies.command,
            ...options,
        };

        return async () => {
            const value = await new Command<V>(supplier, mergedOptions).run();
            return [key, value] as const;
        };
    }

    public supplierStep(
        key: K,
        supplier: () => V | Promise<V>,
    ): OrchestratorStep<K, V> {
        return async () => {
            const value = await supplier();
            return [key, value] as const;
        };
    }

    public loanedValueGetStep(
        key: K,
        loanedValue: LoanedValue<V>,
    ): OrchestratorStep<K, V> {
        return async () => {
            const value = await loanedValue.get();
            return [key, value] as const;
        };
    }

    public loanedValueRefreshStep(
        key: K,
        loanedValue: LoanedValue<V>,
    ): OrchestratorStep<K, V> {
        return async () => {
            const value = await loanedValue.refresh();
            return [key, value] as const;
        };
    }

    public repositoryGetStep(
        repositoryKey: K,
        repository: LoanedRepository<K, V>,
    ): OrchestratorStep<K, V> {
        return async () => {
            const value = await repository.get(repositoryKey);
            return [repositoryKey, value] as const;
        };
    }

    public repositoryRefreshStep(
        repositoryKey: K,
        repository: LoanedRepository<K, V>,
    ): OrchestratorStep<K, V> {
        return async () => {
            const value = await repository.refresh(repositoryKey);
            return [repositoryKey, value] as const;
        };
    }

    public dynamicStep(
        factory: (
            results: OrchestratorResults<K, V>,
        ) => Promise<OrchestratorEntry<K, V>> | OrchestratorEntry<K, V>,
    ): OrchestratorStep<K, V> {
        return async (results) => await factory(results);
    }
}
