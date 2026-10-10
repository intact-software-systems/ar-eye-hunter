import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

/** ALM addresses/checkpoints drive reload decisions; all other metadata values remain opaque. */
export function snapshotExecutableMetadata(metadata: RallarBlackBoxTestRecord): RallarBlackBoxTestRecord {
    if (!isJsonRecordValue(metadata)) {
        return metadata;
    }
    const pair = metadata.almReloadPair;
    return Object.freeze({
        ...metadata,
        ...(Array.isArray(metadata.almReloadCheckpoints)
            ? {
                almReloadCheckpoints: Object.freeze(
                    metadata.almReloadCheckpoints.map((checkpoint) =>
                        isJsonRecordValue(checkpoint) ? Object.freeze({ ...checkpoint }) : checkpoint
                    )
                )
            }
            : {}),
        ...(isJsonRecordValue(pair)
            ? {
                almReloadPair: Object.freeze({
                    ...pair,
                    ...(isJsonRecordValue(pair.sender) ? { sender: Object.freeze({ ...pair.sender }) } : {}),
                    ...(isJsonRecordValue(pair.receiver) ? { receiver: Object.freeze({ ...pair.receiver }) } : {}),
                    ...(Array.isArray(pair.checkpoints)
                        ? {
                            checkpoints: Object.freeze(
                                pair.checkpoints.map((checkpoint) =>
                                    isJsonRecordValue(checkpoint) ? Object.freeze({ ...checkpoint }) : checkpoint
                                )
                            )
                        }
                        : {})
                })
            }
            : {})
    });
}
