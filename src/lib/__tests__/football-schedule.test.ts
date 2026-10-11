import { describe, expect, test } from "bun:test";
import { scheduleContext } from "@/lib/football-schedule";

const KICKOFF = "2026-10-10T15:00:00Z";

describe("football-schedule — J-days", () => {
  test("calcule les jours écoulés et à venir, certitude confirmé", () => {
    const r = scheduleContext(KICKOFF, "2026-10-07T15:00:00Z", "2026-10-15T15:00:00Z");
    expect(r).toEqual({ daysSinceLast: 3, nextInDays: 5, certainty: "confirmé" });
  });

  test("arrondi au jour entier (Math.round, .5 → au-dessus)", () => {
    // écart de 3 j 12 h dans les deux sens → 4 des deux côtés
    const r = scheduleContext(KICKOFF, "2026-10-07T03:00:00Z", "2026-10-14T03:00:00Z");
    expect(r.daysSinceLast).toBe(4);
    expect(r.nextInDays).toBe(4);
    expect(r.certainty).toBe("confirmé");
  });

  test("un des deux matchs manquant → probable, pas inventé", () => {
    const r = scheduleContext(KICKOFF, null, "2026-10-15T15:00:00Z");
    expect(r.daysSinceLast).toBeNull();
    expect(r.nextInDays).toBe(5);
    expect(r.certainty).toBe("probable");
  });

  test("aucune date exploitable → non_confirmé", () => {
    expect(scheduleContext(KICKOFF, null, null)).toEqual({
      daysSinceLast: null,
      nextInDays: null,
      certainty: "non_confirmé",
    });
  });

  test("kickoff illisible → non_confirmé, tout à null", () => {
    const r = scheduleContext("pas-une-date", "2026-10-07T15:00:00Z", null);
    expect(r).toEqual({ daysSinceLast: null, nextInDays: null, certainty: "non_confirmé" });
    expect(scheduleContext(null, null, null).certainty).toBe("non_confirmé");
  });
});
