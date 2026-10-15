import type {
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestResult
} from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { decodeRecord } from './decode-runtime-result-values.ts';

/** Each child streams its own result event, so a composite's event carries child counts in place of their results. */
export function toCommandResultEventPayload(result: RallarBlackBoxTestResult): RallarBlackBoxTestResult {
    if (
        (result.kind !== 'loop' && result.kind !== 'parallel' && result.kind !== 'recipe.run') ||
        !isJsonRecordValue(result.value)
    ) {
        return result;
    }
    const { results, groups, ...summary } = result.value;
    const groupOutcomes = Array.isArray(groups) ? groups.map(decodeRecord) : [];
    const children = [
        ...(Array.isArray(results) ? results : []),
        ...groupOutcomes.flatMap((group) => Array.isArray(group.results) ? group.results : [])
    ].map(decodeRecord);
    const passed = children.filter(isPassedChild).length;
    return {
        ...result,
        value: {
            ...summary,
            childResultCount: children.length,
            passed,
            failed: children.length - passed,
            ...(Array.isArray(groups) ? { groups: groupOutcomes.map(toGroupOutcome) } : {})
        }
    };
}

/** A `recipe.run` lists its children's results; `loop` and `parallel` wrap each in a positioned child record. */
function isPassedChild(child: RallarBlackBoxTestRecord): boolean {
    return (isJsonRecordValue(child.result) ? child.result.ok : child.ok) === true;
}

function toGroupOutcome(group: RallarBlackBoxTestRecord): RallarBlackBoxTestRecord {
    const { results: _results, ...outcome } = group;
    return outcome;
}
