import { describe, it, expect, beforeEach } from "vitest";
import { normalizePhone, setUserPhone, setUserPartnerPhone, findUserByPhone, getUsers } from "@/lib/kv";
import { fakeRedis } from "./redis-fake";

// Phone numbers are typed by hand into /admin but compared byte-for-byte against what Sendblue
// reports as an inbound sender. Sends are forgiving - Sendblue and Twilio both parse
// "+1 929 213 7480" - so a non-canonical stored number looks fine right up until someone replies
// "stop" and the reply matches no user at all. These pin the canonicalization that keeps the two
// ends equal.

describe("normalizePhone", () => {
  it("strips formatting to E.164", () => {
    expect(normalizePhone("+1 929 213 7480")).toBe("+19292137480");
    expect(normalizePhone("(929) 213-7480")).toBe("+19292137480");
    expect(normalizePhone("929-213-7480")).toBe("+19292137480");
    expect(normalizePhone("+19292137480")).toBe("+19292137480");
  });

  it("assumes +1 only for a bare 10-digit number", () => {
    expect(normalizePhone("9292137480")).toBe("+19292137480");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("maps a digitless value to empty, which callers store as undefined", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone("   ")).toBe("");
  });
});

describe("user phone storage", () => {
  beforeEach(() => fakeRedis.reset());

  it("canonicalizes on write so storage never holds a formatted number", async () => {
    await setUserPhone("alan", "(929) 213-7480");
    await setUserPartnerPhone("alan", "412 499 1740");
    const alan = (await getUsers()).find((u) => u.id === "alan");
    expect(alan?.phone).toBe("+19292137480");
    expect(alan?.partnerPhone).toBe("+14124991740");
  });

  it("clears a number when given a blank value", async () => {
    await setUserPhone("alan", "+19292137480");
    await setUserPhone("alan", "");
    expect((await getUsers()).find((u) => u.id === "alan")?.phone).toBeUndefined();
  });

  // The regression that motivated this: an inbound "stop" from Sendblue arrives in strict E.164
  // and has to find a user whose number was stored in a looser form before normalization existed.
  it("matches an inbound E.164 sender against a legacy formatted stored number", async () => {
    fakeRedis.seed("users", [{ id: "alan", label: "Alan", phone: "+1 929 213 7480" }]);
    expect((await findUserByPhone("+19292137480"))?.id).toBe("alan");
  });

  it("does not match a different number", async () => {
    await setUserPhone("alan", "+19292137480");
    expect(await findUserByPhone("+14124991740")).toBeUndefined();
  });
});
