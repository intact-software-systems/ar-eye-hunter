import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from '../control-snapshots.ts';
import type { DistributedRunFailureRow } from './distributed-run-row-contracts.ts';

type ControlCommandSnapshot = ControlRunSnapshot['commands'][number];
type ControlResultSnapshot = ControlRunSnapshot['results'][number];

export function toDistributedRunFailureRows(
    distributedRun: ControlDistributedRunSnapshot,
    results: readonly ControlResultSnapshot[],
    commands: ReadonlyMap<string, ControlCommandSnapshot>
): readonly DistributedRunFailureRow[] {
    const rows = [...toDistributedRunRecordedFailures(distributedRun)];
    results
        .filter((result) => !result.ok)
        .forEach((result) => {
            const command = commands.get(result.commandId);
            rows.push({
                kind: 'command',
                key: result.commandId,
                commandId: result.commandId,
                agentId: result.agentId,
                recipeId: command?.envelope.command.kind === 'recipe.run'
                    ? command.envelope.command.recipe?.recipeId
                    : undefined,
                code: result.error?.code ?? result.result?.error?.code,
                message: result.error?.message ?? result.result?.error?.message ?? 'Command failed.',
                atEpochMs: result.result?.endedAtEpochMs ?? command?.completedAtEpochMs
            });
        });

    return rows.sort((left, right) => (right.atEpochMs ?? 0) - (left.atEpochMs ?? 0));
}

export function toDistributedRunRecordedFailures(
    distributedRun: ControlDistributedRunSnapshot
): DistributedRunFailureRow[] {
    const rows: DistributedRunFailureRow[] = [];
    if (distributedRun.error) {
        rows.push({
            kind: 'run',
            key: distributedRun.distributedRunId,
            code: distributedRun.error.code,
            message: distributedRun.error.message,
            atEpochMs: distributedRun.updatedAtEpochMs
        });
    }

    distributedRun.rollup.failures.forEach((failure) => {
        rows.push({
            kind: failure.kind,
            key: failure.key,
            code: failure.error?.code,
            message: failure.error?.message ?? failure.state,
            atEpochMs: distributedRun.updatedAtEpochMs,
            agentId: failure.kind === 'participant' ? failure.key : undefined,
            recipeId: failure.kind === 'recipe' ? failure.key : undefined
        });
    });
    return rows;
}

export function resolveFirstDistributedFailure(
    failures: readonly DistributedRunFailureRow[]
): DistributedRunFailureRow | undefined {
    return [...failures]
        .sort((left, right) =>
            (left.atEpochMs ?? Number.MAX_SAFE_INTEGER) -
                (right.atEpochMs ?? Number.MAX_SAFE_INTEGER) ||
            left.key.localeCompare(right.key)
        )[0] ?? failures[0];
}
