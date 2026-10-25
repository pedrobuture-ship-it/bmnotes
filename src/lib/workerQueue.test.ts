import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerQueue } from "./workerQueue";
import { renderMarkdownJob } from "./markdownJob";
import { layoutGraph } from "./graphLayout";
import { buildIndex, updateIndex } from "./noteIndex";
import { encryptText, decryptText, ENCRYPTED_MARK } from "./crypto";

function harness() {
  const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null as ((e: { data: { id: number; result?: string } }) => void) | null, onerror: null as (() => void) | null };
  const queue = new WorkerQueue<string, string>(() => worker as unknown as Worker);
  return { worker, queue, reply: (id: number, result: string) => worker.onmessage!({ data: { id, result } }) };
}
afterEach(() => vi.useRealTimers());

describe("background processing", () => {
  it("drops cancelled revisions before execution and ignores stale results", async () => {
    const { queue, worker, reply } = harness();
    const first = queue.submit("first");
    const obsolete = queue.submit("obsolete");
    const latest = queue.submit("latest");
    const ignored = expect(obsolete.promise).rejects.toThrow("Cancelled");
    obsolete.cancel();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    reply(1, "first result");
    expect(worker.postMessage).toHaveBeenLastCalledWith({ id: 3, input: "latest" });
    reply(1, "stale result");
    reply(3, "latest result");
    expect(await first.promise).toBe("first result");
    expect(await latest.promise).toBe("latest result");
    await ignored;
  });

  it("allows the next job to run after an active revision is cancelled", async () => {
    const { queue, reply } = harness();
    const first = queue.submit("old");
    const ignored = expect(first.promise).rejects.toThrow("Cancelled");
    first.cancel();
    const latest = queue.submit("new");
    reply(1, "ignored");
    reply(2, "current");
    expect(await latest.promise).toBe("current");
    await ignored;
  });

  it("terminates a stuck worker and can recover on the next request", async () => {
    vi.useFakeTimers();
    const { queue, worker, reply } = harness();
    const stuck = queue.submit("stuck");
    const failure = expect(stuck.promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    expect(worker.terminate).toHaveBeenCalledOnce();
    const retry = queue.submit("retry");
    reply(2, "recovered");
    expect(await retry.promise).toBe("recovered");
  });

  it("renders nested embeds, links, maths and tasks from serializable input", () => {
    const html = renderMarkdownJob({ path: "a.md", content: "# A\n\n![[b]]\n\n- [ ] Task\n\n$x^2$\n\n[[missing]]", interactive: true, embeds: true, paths: ["a.md", "b.md", "c.md"], sources: [["b.md", "# B\n\n![[c]]"], ["c.md", "Nested body"]], today: "2026-10-25" });
    expect(html).toContain("Nested body");
    expect(html).toContain('data-task="0"');
    expect(html).not.toContain("disabled");
    expect(html).toContain("katex");
    expect(html).toContain("wikilink-missing");
  });

  it("keeps link resolver identity stable for text edits but invalidates renamed paths", () => {
    const original = buildIndex([["a.md", "# A"], ["b.md", "[[a]]"]]);
    const edited = updateIndex(original, [{ path: "a.md", content: "# A edited" }]);
    expect(edited.resolver).toBe(original.resolver);
    const renamed = updateIndex(edited, [{ path: "a.md", content: null }, { path: "c.md", content: "# A edited" }]);
    expect(renamed.resolver).not.toBe(edited.resolver);
    expect(renamed.resolver.resolve("a")).toBeNull();
    expect(renamed.resolver.resolve("c")).toBe("c.md");
  });

  it("lays out disconnected and connected nodes deterministically without mutating input", () => {
    const input = { paths: Array.from({ length: 80 }, (_, i) => `${i}.md`), edges: [{ s: "0.md", t: "1.md" }, { s: "missing.md", t: "1.md" }] };
    const before = JSON.stringify(input);
    const points = layoutGraph(input);
    expect(points).toHaveLength(80);
    expect(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(layoutGraph(input)).toEqual(points);
    expect(JSON.stringify(input)).toBe(before);
    expect(layoutGraph({ paths: [], edges: [] })).toEqual([]);
  });

  it("decrypts notes written with the previous app marker", async () => {
    const encrypted = await encryptText("keep my note", "password");
    expect(encrypted.startsWith("<!-- bmnotes:encrypted v1 -->")).toBe(true);
    const legacy = encrypted.replace(ENCRYPTED_MARK, "<!-- bm-notes:encrypted v1 -->");
    expect(await decryptText(legacy, "password")).toBe("keep my note");
  });
});
