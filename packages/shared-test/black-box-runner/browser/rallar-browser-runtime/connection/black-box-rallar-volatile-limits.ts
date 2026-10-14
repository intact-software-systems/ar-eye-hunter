import {
    AL_VOLATILE_SESSION_LIMITS,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import type { BlackBoxRallarConnectionConfig } from '../black-box-rallar-operation-contracts.ts';

/**
 * The facade is composed before any connect arrives, so it holds only `get` and reads it once per session
 * initialisation (D74); a connect sets the value from its own config before it connects.
 */
export class BlackBoxRallarVolatileLimits {
    #limits: ALVolatileSessionLimits = AL_VOLATILE_SESSION_LIMITS;

    get = (): ALVolatileSessionLimits => this.#limits;

    set(config: BlackBoxRallarConnectionConfig): void {
        this.#limits = config.rallar.almVolatileLimits ?? AL_VOLATILE_SESSION_LIMITS;
    }
}
