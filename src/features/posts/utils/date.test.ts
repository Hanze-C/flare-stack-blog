import { describe, expect, it } from "vitest";
import { isFuturePublishDate, pickedPublishDate, toWholeSecond } from "./date";

describe("isFuturePublishDate", () => {
  const now = new Date("2026-10-29T08:00:00.000Z");

  it("counts a time later the same day as the future", () => {
    expect(isFuturePublishDate(new Date("2026-10-29T08:00:01Z"), now)).toBe(
      true,
    );
  });

  it("takes now and any earlier time", () => {
    expect(isFuturePublishDate(now, now)).toBe(false);
    expect(isFuturePublishDate(new Date("2026-10-28T23:59:59Z"), now)).toBe(
      false,
    );
  });
});

describe("pickedPublishDate", () => {
  it("stores a past day at noon UTC", () => {
    expect(pickedPublishDate("2026-10-01", "2026-10-29").toISOString()).toBe(
      "2026-10-01T12:00:00.000Z",
    );
  });

  it("stores today at its start, so it is never in the future", () => {
    expect(pickedPublishDate("2026-10-29", "2026-10-29").toISOString()).toBe(
      "2026-10-29T00:00:00.000Z",
    );
  });
});

describe("toWholeSecond", () => {
  it("drops the milliseconds", () => {
    expect(
      toWholeSecond(new Date("2026-10-29T08:00:00.789Z")).toISOString(),
    ).toBe("2026-10-29T08:00:00.000Z");
  });
});
