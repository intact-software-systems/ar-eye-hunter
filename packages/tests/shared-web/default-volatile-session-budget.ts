import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

/** A session budget at the production limits, which no test that does not measure the bound comes near. */
export function createDefaultVolatileSessionBudget(): ALVolatileSessionBudget {
    return new ALVolatileSessionBudget({
        maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
        maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
    });
}
