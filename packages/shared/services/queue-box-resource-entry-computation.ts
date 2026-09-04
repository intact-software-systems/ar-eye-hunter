import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '../al-contracts/al-contract.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    type ResourceEntry
} from '../queuebox/ResourceEntry.ts';

export interface ALMessageResourceEntryFacts {
    readonly date: Temporal.PlainTime;
    readonly createdTs: Temporal.PlainDateTime;
}

export function computeResourceEntryFromALMessage(
    msg: ALMessage,
    typeId: string,
    facts: ALMessageResourceEntryFacts
): ResourceEntry {
    const expireAtMs = msg.constraints?.expiresAtMs ?? msg.qos?.expiry?.opts?.expiresAtMs;
    return {
        key: {
            topicId: msg.route.topicId,
            resourceId: msg.route.resourceId,
            contextId: msg.route.contextId
        },
        resource: JSON.stringify(msg),
        typeId,
        audit: {
            date: facts.date,
            createdBy: msg.audit?.createdBy ?? 'test',
            createdTs: facts.createdTs,
            expiryTs: expireAtMs === undefined
                ? NEVER_EXPIRE_TS
                : Temporal.Instant.fromEpochMilliseconds(expireAtMs)
        },
        status: EntityStatus.NEW,
        dequeueAudit: { attempts: 0 },
        db: undefined
    };
}
