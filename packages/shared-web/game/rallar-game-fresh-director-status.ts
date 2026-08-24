import type { RallarDirectorStatus } from '@shared-web/browser/rallar.ts';

export interface RallarGameFreshDirectorStatus extends RallarDirectorStatus {
    readonly appointment: NonNullable<RallarDirectorStatus['appointment']>;
}
