import type { ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { controlResponseDocumentText } from '../../control-response-document.ts';

declare const CONTROL_SNAPSHOT_REVISION: unique symbol;

export type ControlSnapshotRevision = Readonly<{
    [CONTROL_SNAPSHOT_REVISION]: true;
}>;

export type ControlSnapshotRevisionSource =
    | 'root-snapshot'
    | 'canonical-fallback'
    | 'unavailable';

export type ControlSnapshotRevisionSession = Readonly<{
    associate(
        snapshot: ControlServerSnapshot,
        input: Readonly<{
            source: ControlSnapshotRevisionSource;
            rootDocument: unknown;
            fallbackDocument?: unknown;
            detailDocuments?: readonly unknown[];
        }>,
    ): ControlSnapshotRevision;
}>;

type CacheableRevision = Readonly<{
    source: ControlSnapshotRevisionSource;
    rootRawText: string;
    fallbackRawText: string | undefined;
    detailRawTexts: readonly string[];
    token: ControlSnapshotRevision;
}>;

const revisionBySnapshot = new WeakMap<object, ControlSnapshotRevision>();

export function createControlSnapshotRevisionSession(): ControlSnapshotRevisionSession {
    let previous: CacheableRevision | undefined;

    return {
        associate(snapshot, input) {
            const rootRawText = controlResponseDocumentText(input.rootDocument);
            const fallbackRawText =
                input.source === 'canonical-fallback'
                    ? controlResponseDocumentText(input.fallbackDocument)
                    : undefined;
            const detailRawTexts = (input.detailDocuments ?? [])
                .map(controlResponseDocumentText);
            const cacheable =
                rootRawText !== undefined &&
                (input.source !== 'canonical-fallback' ||
                    fallbackRawText !== undefined) &&
                detailRawTexts.every(
                    (text): text is string => text !== undefined,
                );
            let token: ControlSnapshotRevision;

            if (!cacheable) {
                previous = undefined;
                token = createControlSnapshotRevision();
            } else if (
                previous?.source === input.source &&
                previous.rootRawText === rootRawText &&
                previous.fallbackRawText === fallbackRawText &&
                sameTexts(previous.detailRawTexts, detailRawTexts)
            ) {
                token = previous.token;
            } else {
                token = createControlSnapshotRevision();
                previous = {
                    source: input.source,
                    rootRawText,
                    fallbackRawText,
                    detailRawTexts,
                    token,
                };
            }

            revisionBySnapshot.set(snapshot, token);
            return token;
        },
    };
}

function sameTexts(
    left: readonly string[],
    right: readonly (string | undefined)[],
): boolean {
    return left.length === right.length &&
        left.every((text, index) => text === right[index]);
}

export function controlSnapshotRevisionOf(
    snapshot: unknown,
): ControlSnapshotRevision | undefined {
    return snapshot !== null &&
        (typeof snapshot === 'object' || typeof snapshot === 'function')
        ? revisionBySnapshot.get(snapshot as object)
        : undefined;
}

function createControlSnapshotRevision(): ControlSnapshotRevision {
    return Object.freeze(Object.create(null)) as ControlSnapshotRevision;
}
