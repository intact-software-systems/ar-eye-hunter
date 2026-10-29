import type { RelicRuleRefusal } from '../../relic-hunters/src/model.ts';
import type { RelicApplyCommandResult } from '../../relic-hunters/src/rules.ts';
import type { Either } from '../../shared/resilience/Either.ts';

export function requireRelicCommandApplied(result: Either<RelicRuleRefusal, RelicApplyCommandResult>): RelicApplyCommandResult {
    return result.fold(
        (refusal) => {
            throw new Error(`Expected an applied Relic command: ${refusal.message}`);
        },
        (applied) => applied
    );
}
