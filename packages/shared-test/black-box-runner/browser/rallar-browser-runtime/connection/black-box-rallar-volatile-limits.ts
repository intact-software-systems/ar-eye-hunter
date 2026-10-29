import {
    AL_VOLATILE_SESSION_LIMITS,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import { BlackBoxRallarConnectLimits } from './black-box-rallar-connect-limits.ts';

export class BlackBoxRallarVolatileLimits extends BlackBoxRallarConnectLimits<ALVolatileSessionLimits> {
    constructor() {
        super({ defaults: AL_VOLATILE_SESSION_LIMITS, readFromConfig: (config) => config.rallar.almVolatileLimits });
    }
}
