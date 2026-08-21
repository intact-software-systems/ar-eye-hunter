import { compareRallarMatchOrdinalStrings } from './internal.ts';
import type {
    RallarMatchStanding,
    RallarMatchStandingComparator,
    RallarMatchStandingRow,
    RallarMatchStandingsInput
} from './types.ts';

export function deriveRallarMatchStandings(
    input: RallarMatchStandingsInput
): readonly RallarMatchStanding[] {
    const compare = input.compare ?? compareByPointsDescending;
    const rows = Array.from(input.rows).sort((left, right) => {
        const compared = compare(left, right);
        return compared === 0
            ? compareRallarMatchOrdinalStrings(
                left.participantId,
                right.participantId
            )
            : compared;
    });

    let previous: RallarMatchStandingRow | undefined;
    let previousRank = 0;
    let tieGroup = 0;

    return rows.map((row, index): RallarMatchStanding => {
        const sameRank = previous ? compare(previous, row) === 0 : false;
        if (!sameRank) {
            previousRank = index + 1;
            tieGroup += 1;
        }
        previous = row;

        return {
            participantId: row.participantId,
            principalId: row.principalId,
            sessionIds: row.sessionIds,
            metrics: row.metrics,
            rank: previousRank,
            tieGroup
        };
    });
}

export const compareByPointsDescending: RallarMatchStandingComparator = (
    left,
    right
) => {
    const leftPoints = readMetric(left, 'points');
    const rightPoints = readMetric(right, 'points');
    if (leftPoints !== rightPoints) {
        return rightPoints - leftPoints;
    }
    return 0;
};

function readMetric(row: RallarMatchStandingRow, key: string): number {
    const value = row.metrics[key];
    return Number.isFinite(value) ? value : 0;
}
