import {
    AL_VOLATILE_SESSION_LIMITS,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

/** A session budget at the production limits, which no test that does not measure the bound comes near. */
export function createDefaultVolatileSessionBudget(): ALVolatileSessionBudget {
    return new ALVolatileSessionBudget(AL_VOLATILE_SESSION_LIMITS);
}
