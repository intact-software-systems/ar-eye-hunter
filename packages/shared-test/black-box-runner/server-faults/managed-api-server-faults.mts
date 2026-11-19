import { Either } from '../../../shared/resilience/Either.ts';
import type {
    ManagedApiServerLifecycleControls,
    ManagedApiServerPlan,
    ManagedApiServerState
} from '../managed-api/with-managed-api-server-plans.mts';
import {
    SERVER_FAULT_TARGETS,
    type ServerFaultApplied,
    type ServerFaultCommand,
    type ServerFaultRefusal,
    type ServerFaultTarget
} from './server-fault-command.ts';

export namespace ManagedApiServerFaults {
    export interface Input {
        /** In target order: the first plan is `primary`. */
        readonly plans: readonly ManagedApiServerPlan[];
        readonly controls: ManagedApiServerLifecycleControls;
        /** Absent when the run's backend holds no database sessions a process could lose. */
        readonly cutDatabaseSessions: ((plan: ManagedApiServerPlan) => Promise<number>) | undefined;
    }
}

type TargetAction = Exclude<ServerFaultCommand['action'], 'restore'>;

const REFUSAL_BY_STATE: Readonly<Record<TargetAction, Partial<Record<ManagedApiServerState, ServerFaultRefusal>>>> = {
    stop: { stopped: 'not-running' },
    restart: { running: 'already-running', suspended: 'already-running' },
    suspend: { stopped: 'not-running', suspended: 'already-suspended' },
    resume: { stopped: 'not-running', running: 'not-suspended' },
    'cut-database-sessions': { stopped: 'not-running' }
};

/** The faults a recipe may name against the API servers its run manages. */
export class ManagedApiServerFaults {
    private restarts = 0;
    private readonly input: ManagedApiServerFaults.Input;

    constructor(input: ManagedApiServerFaults.Input) {
        this.input = input;
    }

    async apply(command: ServerFaultCommand): Promise<Either<ServerFaultRefusal, ServerFaultApplied>> {
        if (command.action === 'restore') {
            return Either.ofRight({ action: 'restore', restored: await this.restore() });
        }
        const plan = this.input.plans[SERVER_FAULT_TARGETS.indexOf(command.target)];
        if (plan === undefined) {
            return Either.ofLeft('unmanaged-target');
        }
        const refusal = REFUSAL_BY_STATE[command.action][this.input.controls.getState(plan.port)];
        if (refusal !== undefined) {
            return Either.ofLeft(refusal);
        }
        if (command.action === 'cut-database-sessions') {
            return this.input.cutDatabaseSessions === undefined
                ? Either.ofLeft('no-database-sessions')
                : Either.ofRight({
                    action: command.action,
                    terminatedSessions: await this.input.cutDatabaseSessions(plan)
                });
        }
        await this.applyLifecycle(command, plan);
        return Either.ofRight({ action: command.action });
    }

    private async applyLifecycle(
        command: Exclude<ServerFaultCommand, Readonly<{ action: 'restore' | 'cut-database-sessions'; }>>,
        plan: ManagedApiServerPlan
    ): Promise<void> {
        switch (command.action) {
            case 'stop':
                return await this.input.controls.stop(plan.port, command.mode);
            case 'suspend':
                return await this.input.controls.suspend(plan.port);
            case 'resume':
                return await this.input.controls.resume(plan.port);
            case 'restart':
                return await this.restart(plan);
        }
    }

    private async restart(plan: ManagedApiServerPlan): Promise<void> {
        this.restarts += 1;
        await this.input.controls.restart(plan.port, { ...plan, logPath: `${plan.logPath}.restart-${this.restarts}` });
    }

    private async restore(): Promise<readonly ServerFaultTarget[]> {
        const restored: ServerFaultTarget[] = [];
        for (const [index, plan] of this.input.plans.entries()) {
            const state = this.input.controls.getState(plan.port);
            if (state === 'suspended') {
                await this.input.controls.resume(plan.port);
            }
            if (state === 'stopped') {
                await this.restart(plan);
            }
            if (state !== 'running') {
                restored.push(SERVER_FAULT_TARGETS[index]);
            }
        }
        return restored;
    }
}
