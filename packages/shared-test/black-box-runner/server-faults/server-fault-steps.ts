import { Either } from '../../../shared/resilience/Either.ts';
import { toError } from '../../../shared/resilience/to-error.ts';
import { toCorrelationReportFields } from '../execution/black-box-run-correlation.ts';
import type { BlackBoxFetch } from '../execution/black-box-scenario-context.ts';
import { toInteractionOutputFields } from '../execution/black-box-scenario-results.ts';
import {
    decodeServerFaultCommand,
    decodeServerFaultReply,
    type ServerFaultCommand,
    type ServerFaultReply
} from './server-fault-command.ts';

export namespace ServerFaultSteps {
    export interface Input {
        /** Absent when the run manages no API servers. */
        readonly url: string | undefined;
        readonly fetch: BlackBoxFetch;
    }

    export interface Interaction {
        readonly request: Readonly<Record<string, unknown>>;
        readonly response: unknown;
    }

    export interface Status {
        readonly name: string;
        readonly status: 'SUCCESS' | 'FAILURE';
        readonly transport: 'SERVER';
        readonly action: unknown;
        readonly expected: unknown;
        readonly actual: unknown;
        readonly [field: string]: unknown;
    }
}

interface StepOutcome {
    readonly status: ServerFaultSteps.Status['status'];
    /** Absent on a step that succeeded. */
    readonly result?: string;
    readonly actual: unknown;
}

const UNMANAGED_RUN = 'This run manages no API servers, so a server step has nothing to act on.';

function toFailure(result: string, actual: unknown = undefined): StepOutcome {
    return { status: 'FAILURE', result, actual };
}

function toReplyOutcome(reply: ServerFaultReply): StepOutcome {
    switch (reply.outcome) {
        case 'applied':
            return { status: 'SUCCESS', actual: reply.applied };
        case 'refused':
            return toFailure(`The run refused the server step: ${reply.refusal}.`, reply);
        case 'invalid':
            return toFailure(`The run could not read the server step: ${reply.issue}.`, reply);
    }
}

/** A recipe's `server` steps, and the restoring of whatever they left stopped or suspended. */
export class ServerFaultSteps {
    private faulted = false;
    private readonly input: ServerFaultSteps.Input;

    constructor(input: ServerFaultSteps.Input) {
        this.input = input;
    }

    async execute(
        interaction: ServerFaultSteps.Interaction,
        interactionName: string,
        dryRun: boolean
    ): Promise<ServerFaultSteps.Status> {
        const outcome = await this.computeOutcome(interaction, dryRun);
        return {
            name: interactionName,
            transport: 'SERVER',
            action: interaction.request.action,
            ...toCorrelationReportFields(interaction),
            scenarioExecutionNumber: interaction.request.scenarioExecutionNumber,
            interactionExecutionNumber: interaction.request.interactionExecutionNumber,
            repeatIndex: interaction.request.repeatIndex,
            expected: interaction.response,
            ...toInteractionOutputFields(interaction),
            ...outcome
        };
    }

    /** Leaves every server of the run running again when a step of this run faulted one. */
    async restore(): Promise<void> {
        if (!this.faulted) {
            return;
        }
        const outcome = await this.send({ action: 'restore' });
        if (outcome.status === 'FAILURE') {
            throw new Error(`The run's API servers were not restored. ${outcome.result}`);
        }
    }

    private async computeOutcome(interaction: ServerFaultSteps.Interaction, dryRun: boolean): Promise<StepOutcome> {
        const command = decodeServerFaultCommand(interaction.request);
        if (command.right === undefined) {
            return toFailure(`A server step is invalid: ${command.left}.`);
        }
        if (dryRun) {
            return { status: 'SUCCESS', actual: { dryRun: true, command: command.right } };
        }
        return await this.send(command.right);
    }

    private async send(command: ServerFaultCommand): Promise<StepOutcome> {
        if (this.input.url === undefined) {
            return toFailure(UNMANAGED_RUN);
        }
        this.faulted = command.action !== 'restore';
        const reply = await this.post(this.input.url, command);
        return reply.fold((issue) => toFailure(issue), toReplyOutcome);
    }

    private async post(url: string, command: ServerFaultCommand): Promise<Either<string, ServerFaultReply>> {
        try {
            const response = await this.input.fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(command)
            });
            return decodeServerFaultReply(await response.json());
        }
        catch (error) {
            return Either.ofLeft(`The server fault endpoint did not answer: ${toError(error).message}.`);
        }
    }
}
