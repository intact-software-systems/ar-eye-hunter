import {describe, expect, it} from "vitest"

describe("date", () => {

    it('date', () => {

        const value = "Thu Feb 19 2026 09:23:18 GMT+0100 (Central European Standard Time)"

        const date = new Date(value);

        const instant = Temporal.Instant.from(date.toISOString());
        const plainDateTime = instant.toZonedDateTimeISO("UTC").toPlainDateTime();

        expect(plainDateTime).toBeTruthy();
    })

})