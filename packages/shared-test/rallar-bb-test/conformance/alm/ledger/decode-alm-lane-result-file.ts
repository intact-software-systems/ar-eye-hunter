import { Either } from '@shared/resilience/Either.ts';

import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import { decodeJsonText } from '../lane-result/alm-lane-file-field.ts';
import type { AlmLaneFamilyResult, AlmLanePlanRecord, AlmLaneRunIdentity } from '../lane-result/alm-lane-result.ts';
import { decodeAlmLaneFamilyResult, decodeAlmLanePlanRecord } from '../lane-result/decode-alm-lane-result.ts';
import { ALM_LANE_LEDGER_IDENTITY } from './alm-lane-workflow-names.ts';

export interface AlmLaneResultFile {
    readonly fileName: string;
    readonly text: string;
}

/** A decoded file whose identity agrees with its job. */
export type AlmLaneDecodedFile =
    | { readonly kind: 'plan'; readonly fileName: string; readonly record: AlmLanePlanRecord; }
    | { readonly kind: 'result'; readonly fileName: string; readonly record: AlmLaneFamilyResult; };

/**
 * A file of a carrier's result artifact: a name ending in `-plan.json` is a plan, every other file a family result.
 * Each issue names the file; a file that is not JSON, does not decode, or states another carrier, scope or backend
 * than the job is refused.
 */
export function decodeAlmLaneResultFile(
    file: AlmLaneResultFile,
    carrier: AlmConformanceCarrier
): Either<readonly string[], AlmLaneDecodedFile> {
    const value = decodeJsonText(file.text);
    if (value === undefined) {
        return Either.ofLeft([`${file.fileName} is not JSON.`]);
    }
    const decoded = file.fileName.endsWith('-plan.json')
        ? decodeAlmLanePlanRecord(value).mapRight((record): AlmLaneDecodedFile => ({
            kind: 'plan',
            fileName: file.fileName,
            record
        }))
        : decodeAlmLaneFamilyResult(value).mapRight((record): AlmLaneDecodedFile => ({
            kind: 'result',
            fileName: file.fileName,
            record
        }));
    return decoded.fold(
        (issues) => Either.ofLeft(issues.map((issue) => `${file.fileName}: ${issue}`)),
        (accepted) => validateIdentity(accepted, { carrier, ...ALM_LANE_LEDGER_IDENTITY })
    );
}

function validateIdentity(
    file: AlmLaneDecodedFile,
    expected: AlmLaneRunIdentity
): Either<readonly string[], AlmLaneDecodedFile> {
    const { carrier, scope, backend } = file.record;
    if (carrier === expected.carrier && scope === expected.scope && backend === expected.backend) {
        return Either.ofRight(file);
    }
    return Either.ofLeft([
        `${file.fileName} is for ${toIdentityText(file.record)}; the job is for ${toIdentityText(expected)}.`
    ]);
}

function toIdentityText(identity: AlmLaneRunIdentity): string {
    return `carrier ${identity.carrier}, scope ${identity.scope} and backend ${identity.backend}`;
}
