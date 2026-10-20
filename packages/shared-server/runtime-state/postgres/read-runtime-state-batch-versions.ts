import type {
    RuntimeStateReadBatchSelector,
    RuntimeStateReadBatchVersion,
    RuntimeStateReadBatchVersionReader
} from '../read-batch/runtime-state-read-batch.ts';
import { splitRuntimeStateReadBatchVersion } from './to-runtime-state-read-batch-selections.ts';

/**
 * Every group's version from one probe statement over all groups' selectors, each equal to the version a probe of
 * that group alone reports; a selector ID is unique within its group, so the group ordinal keeps it unique in the batch.
 */
export async function readRuntimeStateBatchVersions(
    reader: Pick<RuntimeStateReadBatchVersionReader, 'readRuntimeStateBatchVersion'>,
    selectorGroups: readonly (readonly RuntimeStateReadBatchSelector[])[]
): Promise<readonly (RuntimeStateReadBatchVersion['version'] | undefined)[]> {
    if (selectorGroups.length === 0) {
        return [];
    }
    const version = await reader.readRuntimeStateBatchVersion(
        selectorGroups.flatMap((selectors, groupOrdinal) =>
            selectors.map((selector) => ({ ...selector, selectorId: `${groupOrdinal}:${selector.selectorId}` }))
        )
    );
    return splitRuntimeStateReadBatchVersion(version, selectorGroups.map((selectors) => selectors.length));
}
