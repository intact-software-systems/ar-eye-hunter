import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import type { BlackBoxRallarConnectionConfig } from '../black-box-rallar-operation-contracts.ts';

const DEFAULT_LIMITS: ALVolatileSessionLimits = {
    maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
};

/**
 * The facade is composed before any connect arrives, so it holds only `get` and reads it once per session
 * initialisation (D74); a connect sets the value from its own config before it connects.
 */
export class BlackBoxRallarVolatileLimits {
    #limits: ALVolatileSessionLimits = DEFAULT_LIMITS;

    get = (): ALVolatileSessionLimits => this.#limits;

    set(config: BlackBoxRallarConnectionConfig): void {
        this.#limits = config.rallar.almVolatileLimits ?? DEFAULT_LIMITS;
    }
}
