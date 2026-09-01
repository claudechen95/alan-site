import { describe, it, expect } from "vitest";
import { getWeekKey, getWeekLabel } from "@/lib/kv";

// The three week conventions have to agree: getWeekKey (what notes are stored under),
// getWeekLabel (what the user reads), and the Monday-start week weekly goals are scored over.
// They drifted apart before Aug 2026 - getWeekKey numbered weeks off Jan 4's weekday, so in
// 2026 it returned Sunday-Saturday weeks numbered one below ISO, and "this week" resolved to
// last week's note key. Writing a note would have overwritten the previous week's.

// Monday-start week the goal tracker scores over (mirrors getWeekDatesForDate, which is private).
function goalWeekMonday(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const ref = new Date(Date.UTC(y, m - 1, d, 12));
  ref.setUTCDate(ref.getUTCDate() - ((ref.getUTCDay() + 6) % 7));
  return ref.toISOString().slice(0, 10);
}

describe("getWeekKey", () => {
  it.each([
    // [date, expected ISO key] - hand-checked against the ISO-8601 calendar.
    ["2026-08-26", "2026-W35"], // the Wednesday the bug was found on
    ["2026-08-24", "2026-W35"], // Monday starts the week
    ["2026-08-30", "2026-W35"], // Sunday still closes the same week
    ["2026-08-31", "2026-W36"], // next Monday rolls over
    ["2026-01-04", "2026-W01"], // week 1 is the week containing Jan 4
    ["2025-12-29", "2026-W01"], // ISO year can lead the calendar year
    ["2026-12-31", "2026-W53"], // 2026 is a 53-week ISO year
  ])("maps %s to %s", (date, expected) => {
    expect(getWeekKey(date)).toBe(expected);
  });

  it("gives Sunday and the following Monday different keys", () => {
    expect(getWeekKey("2026-08-30")).not.toBe(getWeekKey("2026-08-31"));
  });

  it("agrees with the Monday-start week that weekly goals are scored over", () => {
    // 400 consecutive days from Dec 2025, so the sweep crosses both year boundaries. The key's
    // label must name the same Monday the tracker scores over, on every single day. This is the
    // assertion that would have caught the original off-by-one-week bug.
    for (let i = 0; i < 400; i++) {
      const d = new Date(Date.UTC(2025, 11, 1 + i));
      const dateStr = d.toISOString().slice(0, 10);
      const monday = goalWeekMonday(dateStr);
      const expectedLabel = `Week of ${new Date(monday + "T12:00:00Z").toLocaleDateString("en-US", {
        month: "short",
        timeZone: "UTC",
      })} ${Number(monday.slice(8))}`;

      expect(getWeekLabel(getWeekKey(dateStr)), `mismatch on ${dateStr}`).toBe(expectedLabel);
    }
  });

  // Notes already in Redis are keyed by week and carry their own stored label. If getWeekKey or
  // getWeekLabel ever shifts again, these are the notes that would silently start rendering
  // under the wrong week - so the mapping is pinned here against the real stored values.
  it.each([
    ["2026-W13", "Week of Mar 23"],
    ["2026-W32", "Week of Aug 3"],
    ["2026-W33", "Week of Aug 10"],
    ["2026-W34", "Week of Aug 17"],
  ])("keeps stored note %s labelled %s", (key, label) => {
    expect(getWeekLabel(key)).toBe(label);
  });

  it("round-trips every key back to its own Monday", () => {
    for (let i = 0; i < 365; i++) {
      const dateStr = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      const key = getWeekKey(dateStr);
      // The label is derived from the key alone, so re-deriving the key from any day of that
      // week must land back on the same key.
      expect(getWeekKey(goalWeekMonday(dateStr))).toBe(key);
    }
  });
});
