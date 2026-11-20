import { afterEach, describe, expect, it } from "vitest";
import { RunStateError, UnknownRunError } from "../src/chaser.js";
import { INJECTION, startWorld } from "./world.js";

let world: Awaited<ReturnType<typeof startWorld>> | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

const asOf = "2026-11-20";

describe("the workflow and approval", () => {
  it("stops for approval and sends nothing until a person decides", async () => {
    world = await startWorld();
    const view = await world.chaser.start(asOf);
    expect(view.status).toBe("awaiting_approval");
    expect(view.drafts.map((d) => d.contactId)).toEqual(["T1"]);
    expect(view.outcomes).toMatchObject([
      { contactId: "T2", action: "hold", reason: "dispute_open" },
    ]);
    expect(world.outbox.messages).toHaveLength(0);
  });

  it("sends after approval, to the accounting contact, and only once", async () => {
    world = await startWorld();
    const view = await world.chaser.start(asOf);
    const d = view.drafts[0];
    if (!d) throw new Error("no draft");
    const done = await world.chaser.decide(view.runId, {
      reviewer: "rod",
      decisions: [{ contactId: "T1", approve: true, draftHash: d.draftHash }],
    });
    expect(done.status).toBe("done");
    expect(done.outcomes.find((o) => o.contactId === "T1")?.delivery).toBe("sent");
    expect(world.outbox.messages.map((m) => m.to)).toEqual(["alex@customer.example"]);
    await expect(
      world.chaser.decide(view.runId, { reviewer: "rod", decisions: [] }),
    ).rejects.toBeInstanceOf(RunStateError);
    expect(world.outbox.messages).toHaveLength(1);
  });

  it("an approval for different content than the draft shown is not an approval", async () => {
    world = await startWorld();
    const view = await world.chaser.start(asOf);
    const done = await world.chaser.decide(view.runId, {
      reviewer: "rod",
      decisions: [{ contactId: "T1", approve: true, draftHash: "0".repeat(64) }],
    });
    expect(done.outcomes.find((o) => o.contactId === "T1")?.delivery).toBe("rejected");
    expect(world.outbox.messages).toHaveLength(0);
  });

  it("a draft with no decision is not sent", async () => {
    world = await startWorld();
    const view = await world.chaser.start(asOf);
    const done = await world.chaser.decide(view.runId, { reviewer: "rod", decisions: [] });
    expect(done.outcomes.find((o) => o.contactId === "T1")).toMatchObject({
      delivery: "rejected",
      note: "no decision given",
    });
    expect(world.outbox.messages).toHaveLength(0);
  });

  it("refuses malformed decisions and unknown runs", async () => {
    world = await startWorld();
    const view = await world.chaser.start(asOf);
    await expect(
      world.chaser.decide(view.runId, { reviewer: "", decisions: [] }),
    ).rejects.toThrow();
    await expect(world.chaser.view("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      UnknownRunError,
    );
  });

  it("an injected note that the model obeys never reaches the person", async () => {
    world = await startWorld("follows_injection");
    const view = await world.chaser.start(asOf);
    expect(view.status).toBe("done");
    expect(view.outcomes.find((o) => o.contactId === "T1")).toMatchObject({
      action: "hold",
      reason: "draft_failed_checks",
    });
    expect(world.outbox.messages).toHaveLength(0);
  });

  it("the audit log records decisions but never message bodies or notes", async () => {
    world = await startWorld();
    const view = await world.chaser.start(asOf);
    const d = view.drafts[0];
    if (!d) throw new Error("no draft");
    await world.chaser.decide(view.runId, {
      reviewer: "rod",
      decisions: [{ contactId: "T1", approve: true, draftHash: d.draftHash }],
    });
    const audit = await world.store.listAudit(view.runId);
    expect(audit.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "run_started",
        "assessed",
        "draft_checked",
        "decision",
        "send_result",
      ]),
    );
    const text = JSON.stringify(audit);
    expect(text).not.toContain(d.content.body.slice(0, 40));
    expect(text).not.toContain(INJECTION.slice(0, 30));
    expect(text).not.toContain("Customer unhappy");
    expect(text).not.toContain(d.key);
  });
});
