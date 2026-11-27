import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { ClientStateRepositoryInvariantCorruptionError } from '../persistence/client-state-persistence-contracts.ts';
import { CLIENT_STATE_WS_CONNECTION_HOLDERS_NAMESPACE } from '../persistence/client-state-runtime-namespaces.ts';
import {
    decodeWsConnectionHolderRecordEntry,
    toWsConnectionHolderGenerationKeySuffix,
    toWsConnectionHolderKeyPrefix,
    type WsConnectionHolderGenerationRef,
    type WsConnectionHolderRecordEntry
} from './ws-connection-holder-record.ts';

export interface WsConnectionHolderRecordReaderDependencies {
    readonly repository: RuntimeStateRepositoryLike;
    /** A record whose expiry is at or before this instant reads as absent, as every runtime-state read takes it. */
    readonly nowMs: () => number;
}

export interface WsConnectionHolderPageInput {
    readonly holderId: string;
    readonly afterKey: string | null;
    readonly limit: number;
}

export interface WsConnectionHolderPage {
    readonly records: readonly WsConnectionHolderRecordEntry[];
    /** The last stored key of a full page, expired rows included; null once the holder's range is exhausted. */
    readonly nextAfterKey: string | null;
}

export interface WsConnectionHolderRecordReader {
    /** The live record of one socket generation, whichever process holds it. */
    readGenerationRecord(ref: WsConnectionHolderGenerationRef): Promise<WsConnectionHolderRecordEntry | null>;
    /** One page of the live records one process holds, in storage-key order. */
    readHolderPage(input: WsConnectionHolderPageInput): Promise<WsConnectionHolderPage>;
}

export function createWsConnectionHolderRecordReader(
    dependencies: WsConnectionHolderRecordReaderDependencies
): WsConnectionHolderRecordReader {
    const { repository, nowMs } = dependencies;
    const toLiveRecords = (entries: readonly RuntimeStateEntry[]): readonly WsConnectionHolderRecordEntry[] => {
        const observedAtEpochMs = nowMs();
        return entries
            .filter((entry) => entry.expireAtTimestamp > observedAtEpochMs)
            .map(decodeWsConnectionHolderRecordEntry);
    };
    return {
        readGenerationRecord: async (ref) => {
            const [selection] = await repository.readRuntimeStateBatch([{
                selectorId: 'ws-connection-holder-generation',
                kind: 'suffix',
                namespace: CLIENT_STATE_WS_CONNECTION_HOLDERS_NAMESPACE,
                keySuffix: toWsConnectionHolderGenerationKeySuffix(ref)
            }]);
            const [record, second] = toLiveRecords(selection.entries);
            if (second !== undefined) {
                throw new ClientStateRepositoryInvariantCorruptionError(
                    second.key,
                    'A WebSocket connection generation has more than one holder record'
                );
            }
            return record ?? null;
        },
        readHolderPage: async (input) => {
            const entries = await repository.findEntriesByPrefixPage(
                CLIENT_STATE_WS_CONNECTION_HOLDERS_NAMESPACE,
                toWsConnectionHolderKeyPrefix(input.holderId),
                { ...(input.afterKey === null ? {} : { afterKey: input.afterKey }), limit: input.limit }
            );
            return {
                records: toLiveRecords(entries),
                nextAfterKey: entries.length === input.limit ? entries.at(-1)?.key ?? null : null
            };
        }
    };
}
