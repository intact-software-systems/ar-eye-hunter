import {
    RuntimeStateWriteConflictError,
    type AppInboxMessageContext,
    type JsonWireValue,
    type PSqlSql,
    type RallarServerAppInbox
} from '@shared-server/mod.ts';

interface CounterRow {
    readonly value: number;
    readonly revision: number;
}

interface CounterRead {
    readonly input: CounterService.Command;
    readonly counter: CounterRow | undefined;
}

interface CounterComputed {
    readonly read: CounterRead;
    readonly result: CounterService.Result;
}

export namespace CounterService {
    export interface Command {
        readonly counterId: string;
        readonly requestId: string;
        readonly capturedAtEpochMs: number | null;
    }

    export type Result =
        | {
            readonly status: 'updated';
            readonly counterId: string;
            readonly capturedAtEpochMs: number;
            readonly value: number;
        }
        | {
            readonly status: 'refused';
            readonly counterId: string;
            readonly capturedAtEpochMs: number;
            readonly code: 'counter-unavailable' | 'capacity';
        };

    export interface Dependencies {
        readonly appInbox: RallarServerAppInbox;
        readonly database: PSqlSql;
        readonly nowEpochMs: () => number;
    }
}

/** Register on every claimant before rallar.start(); authenticate callers before admitting commands. */
export class CounterService {
    readonly increment: RallarServerAppInbox.Operation<CounterService.Command, CounterService.Result>;
    private readonly dependencies: CounterService.Dependencies;

    constructor(dependencies: CounterService.Dependencies) {
        this.dependencies = dependencies;
        this.increment = dependencies.appInbox.register({
            type: 'app:counter:increment',
            decodeEnvelope: ({ data }) => decodeCounterCommand(data),
            encodeEnvelope: (command) => ({ data: { ...command } }),
            toBinding: (command) => ({ contextId: command.counterId, resourceId: command.requestId }),
            toLogicalCommand: (command) => ({ counterId: command.counterId, requestId: command.requestId }),
            materialize: (command) => ({ ...command, capturedAtEpochMs: dependencies.nowEpochMs() }),
            encodeResult: (result: CounterService.Result) => ({ ...result }),
            decodeResult: decodeCounterResult,
            handle: (command, context) => this.incrementCounter(command, context)
        });
    }

    private async incrementCounter(
        command: CounterService.Command,
        context: AppInboxMessageContext<CounterService.Result>
    ): Promise<CounterService.Result> {
        const read = await this.readCounter(command);
        const computed = computeCounter(read);
        const issues = validateCounter(computed);
        if (issues[0]) {
            throw new TypeError(issues[0]);
        }
        return await this.dependencies.appInbox.commit(
            context,
            computed.result,
            (transaction) => writeCounter(transaction, computed)
        );
    }

    private async readCounter(input: CounterService.Command): Promise<CounterRead> {
        const [counter] = await this.dependencies.database<
            CounterRow[]
        >`select value, revision from app_counter where id = ${input.counterId}`;
        return { input, counter };
    }
}

function computeCounter(read: CounterRead): CounterComputed {
    const { input, counter } = read;
    if (input.capturedAtEpochMs === null) {
        throw new TypeError('Counter command lacks its captured timestamp');
    }
    const identity = { counterId: input.counterId, capturedAtEpochMs: input.capturedAtEpochMs };
    const result: CounterService.Result = counter === undefined
        ? { ...identity, status: 'refused', code: 'counter-unavailable' }
        : counter.value === 2_147_483_647
        ? { ...identity, status: 'refused', code: 'capacity' }
        : { ...identity, status: 'updated', value: counter.value + 1 };
    return { read, result };
}

function validateCounter(computed: CounterComputed): readonly string[] {
    return JSON.stringify(computed.result) === JSON.stringify(computeCounter(computed.read).result)
        ? []
        : ['Counter candidate differs from its read and command'];
}

async function writeCounter(transaction: PSqlSql, computed: CounterComputed): Promise<void> {
    if (computed.result.status === 'refused' || computed.read.counter === undefined) {
        return;
    }
    const written = await transaction<readonly { revision: number; }[]>`
        update app_counter set value = ${computed.result.value}, revision = revision + 1
        where id = ${computed.read.input.counterId} and revision = ${computed.read.counter.revision}
        returning revision`;
    if (written.length !== 1) {
        throw new RuntimeStateWriteConflictError();
    }
}

function decodeCounterCommand(value: JsonWireValue): CounterService.Command {
    if (
        value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
        !('counterId' in value) || !('requestId' in value) || !('capturedAtEpochMs' in value) ||
        typeof value.counterId !== 'string' || typeof value.requestId !== 'string' ||
        (value.capturedAtEpochMs !== null &&
            (typeof value.capturedAtEpochMs !== 'number' || !Number.isSafeInteger(value.capturedAtEpochMs) ||
                value.capturedAtEpochMs < 0))
    ) {
        throw new TypeError('Counter command is malformed');
    }
    return { counterId: value.counterId, requestId: value.requestId, capturedAtEpochMs: value.capturedAtEpochMs };
}

function decodeCounterResult(value: JsonWireValue, command: CounterService.Command): CounterService.Result {
    if (
        value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 ||
        !('counterId' in value) || !('capturedAtEpochMs' in value) || !('status' in value) ||
        value.counterId !== command.counterId || value.capturedAtEpochMs !== command.capturedAtEpochMs ||
        command.capturedAtEpochMs === null
    ) {
        throw new TypeError('Counter result differs from its retained command');
    }
    const identity = { counterId: command.counterId, capturedAtEpochMs: command.capturedAtEpochMs };
    if (
        value.status === 'updated' && 'value' in value && typeof value.value === 'number' &&
        Number.isInteger(value.value) &&
        value.value >= 0 && value.value <= 2_147_483_647
    ) {
        return { ...identity, status: 'updated', value: value.value };
    }
    if (
        value.status === 'refused' && 'code' in value &&
        (value.code === 'counter-unavailable' || value.code === 'capacity')
    ) {
        return { ...identity, status: 'refused', code: value.code };
    }
    throw new TypeError('Counter result is malformed');
}
