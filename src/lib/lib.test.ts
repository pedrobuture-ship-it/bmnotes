import { describe, expect, it, vi } from "vitest";
import { extractTags, extractTitle, extractWikiLinks, removeWikiLinks, toggleCheckbox } from "./markdownText";
import { slugify } from "./slug";
import { createResolver } from "./wikiResolve";
import { buildIndex, updateIndex } from "./noteIndex";
import { searchNotes, fuzzyScore } from "./search";
import { resolveRelative, isSafeRelativePath, basename, dirname } from "./paths";
import { normalizeBoard, autoLayout } from "./board";
import { renderMarkdown } from "./markdown";
import { planLinkUpdates } from "./renameLinks";

describe("wiki links", () => {
  it("extracts targets, aliases and headings", () => {
    const links = extractWikiLinks("a [[arquitetura]] b [[faculdade/calculo|Cálculo]] c [[nota#sec]]");
    expect(links.map((l) => l.target)).toEqual(["arquitetura", "faculdade/calculo", "nota"]);
    expect(links[1]?.alias).toBe("Cálculo");
  });
  it("ignores code and leaves normal links alone", () => {
    expect(extractWikiLinks("`[[x]]`\n```\n[[y]]\n```\n[txt](http://a.b) [[ok]]").map((l) => l.target)).toEqual(["ok"]);
  });
  it("resolves by path or unique basename, case-insensitively", () => {
    const r = createResolver(["faculdade/Calculo.md", "ideias.md"]);
    expect(r.resolve("faculdade/calculo")).toBe("faculdade/Calculo.md");
    expect(r.resolve("calculo")).toBe("faculdade/Calculo.md");
    expect(r.resolve("Ideias.md")).toBe("ideias.md");
    expect(r.resolve("nope")).toBeNull();
  });
});

describe("tags", () => {
  it("detects tags but not headings, numbers, urls or code", () => {
    const t = extractTags("# Title\n#projeto and #Faculdade/ads\nissue #123 http://x.com/#frag `#code`\n```\n#fence\n```\n");
    expect(t.sort()).toEqual(["faculdade/ads", "projeto"]);
  });
});

describe("titles", () => {
  it("uses the first h1 outside code", () => {
    expect(extractTitle("```\n# no\n```\n# Real title #\n", "f")).toBe("Real title");
    expect(extractTitle("text", "fallback")).toBe("fallback");
  });
});

describe("checkboxes", () => {
  const src = "- [ ] Fazer prova\n```\n- [ ] in code\n```\n  - [x] pronta\n1. [ ] third\n";
  it("toggles only the requested task and preserves the rest", () => {
    expect(toggleCheckbox(src, 0)).toBe(src.replace("- [ ] Fazer", "- [x] Fazer"));
    expect(toggleCheckbox(src, 1)).toBe(src.replace("[x] pronta", "[ ] pronta"));
    expect(toggleCheckbox(src, 2)).toBe(src.replace("1. [ ]", "1. [x]"));
    expect(toggleCheckbox(src, 3)).toBeNull();
  });
});

describe("slug and paths", () => {
  it("slugifies safely", () => {
    expect(slugify("Minha ideia")).toBe("minha-ideia");
    expect(slugify("  Ação ../ perigosa!! ")).toBe("acao-perigosa");
    expect(slugify("///")).toBe("untitled");
  });
  it("resolves and validates relative paths", () => {
    expect(resolveRelative("a/b", "../assets/x.png")).toBe("a/assets/x.png");
    expect(resolveRelative("", "../x.png")).toBeNull();
    expect(isSafeRelativePath("../x")).toBe(false);
    expect(isSafeRelativePath("a/b.md")).toBe(true);
    expect(basename("a/b/c.md")).toBe("c.md");
    expect(dirname("c.md")).toBe("");
  });
});

describe("index + search", () => {
  const notes = new Map([
    ["frontend.md", "# Frontend\nusa [[arquitetura]] #projeto"],
    ["arquitetura.md", "# Arquitetura\nreact e tauri"],
    ["roadmap.md", "# Roadmap\n[[arquitetura]] [[frontend]]"],
  ]);
  const idx = buildIndex(notes);
  it("computes backlinks and tags", () => {
    expect(idx.backlinks.get("arquitetura.md")?.sort()).toEqual(["frontend.md", "roadmap.md"]);
    expect(idx.tags.get("projeto")).toEqual(["frontend.md"]);
  });
  it("updates incrementally", () => {
    const next = updateIndex(idx, [{ path: "roadmap.md", content: "# Roadmap" }]);
    expect(next.backlinks.get("arquitetura.md")).toEqual(["frontend.md"]);
    expect(updateIndex(idx, [{ path: "frontend.md", content: null }]).meta.has("frontend.md")).toBe(false);
  });
  it("ranks name matches above content matches and builds snippets", () => {
    const r = searchNotes(idx, (p) => notes.get(p) ?? "", "tauri");
    expect(r[0]?.path).toBe("arquitetura.md");
    expect(r[0]?.marks.length).toBeGreaterThan(0);
    expect(searchNotes(idx, (p) => notes.get(p) ?? "", "arquitetura")[0]?.path).toBe("arquitetura.md");
    expect(searchNotes(idx, (p) => notes.get(p) ?? "", "#projeto")[0]?.path).toBe("frontend.md");
    expect(searchNotes(idx, () => "", "zzzz")).toEqual([]);
  });
  it("fuzzy matches subsequences", () => {
    expect(fuzzyScore("Toggle sidebar", "tgsb")).not.toBeNull();
    expect(fuzzyScore("Fit board", "zzz")).toBeNull();
  });
});

describe("board", () => {
  it("normalizes corrupt data without throwing", () => {
    const b = normalizeBoard({ cards: { "a.md": { x: "bad", w: 5 }, "b.md": null }, frames: [{ nope: 1 }], connections: [1] });
    expect(b.cards["a.md"]?.x).toBe(0);
    expect(b.cards["a.md"]?.w).toBe(160);
    expect(b.frames).toEqual([]);
    expect(normalizeBoard("garbage").version).toBe(1);
  });
  it("auto layout keeps existing cards in place", () => {
    const existing = { "a.md": { x: 10, y: 10, w: 280, h: 200, color: "paper" as const } };
    const out = autoLayout(["a.md", "b.md"], existing);
    expect(out["a.md"]).toBe(existing["a.md"]);
    expect(out["b.md"]).toBeDefined();
  });
});

describe("markdown render", () => {
  it("renders wiki links, tasks and rewrites images", () => {
    const html = renderMarkdown("[[Foo|bar]] [x](http://a.b)\n\n- [ ] t\n\n![](<assets/a b.png>)\n\n```ts\nconst a = 1;\n```", {
      notePath: "n/x.md",
      interactiveTasks: true,
      resolves: () => false,
    });
    expect(html).toContain('data-wiki="Foo"');
    expect(html).toContain("wikilink-missing");
    expect(html).toContain('data-task="0"');
    expect(html).not.toContain("disabled");
    expect(html).toContain("n/assets/a%20b.png");
    expect(html).toContain("hljs");
  });
  it("strips scripts", () => {
    expect(renderMarkdown("<script>alert(1)</script><img src=x onerror=alert(1)>", { notePath: "a.md" })).not.toMatch(/script|onerror/);
  });
});

import { relativeFrom } from "./paths";
import { dailyTemplate, dateStamp, timeStamp } from "./daily";

describe("relative asset paths and daily notes", () => {
  it("computes paths from the note folder to the asset", () => {
    expect(relativeFrom("", "assets/a.png")).toBe("assets/a.png");
    expect(relativeFrom("projetos", "assets/a.png")).toBe("../assets/a.png");
    expect(relativeFrom("a/b", "a/assets/x.png")).toBe("../assets/x.png");
  });
  it("formats stamps and the daily template", () => {
    const d = new Date(2026, 0, 5, 7, 8, 9);
    expect(dateStamp(d)).toBe("2026-01-05");
    expect(timeStamp(d)).toBe("2026-01-05-070809");
    expect(dailyTemplate("2026-01-05")).toBe("# 2026-01-05\n\n## Notes\n\n- \n\n## Tasks\n\n- [ ] \n");
  });
});

describe("removeWikiLinks", () => {
  const is = (t: string) => (x: string) => x === t;
  it("removes a link alone on its line along with the line", () => {
    expect(removeWikiLinks("# A\n\n[[b]]\n[[c]]\n", is("b"))).toBe("# A\n\n[[c]]\n");
  });
  it("removes an inline link and its leading space", () => {
    expect(removeWikiLinks("see [[b]] now", is("b"))).toBe("see now");
  });
  it("removes aliased links and leaves code alone", () => {
    expect(removeWikiLinks("x\n[[b|Bee]]\n`[[b]]`", is("b"))).toBe("x\n`[[b]]`");
  });
});

describe("planLinkUpdates", () => {
  const notes = {
    "architecture.md": "# Architecture\n",
    "Ideas.md": "See [[architecture]] and [[Architecture|the design]] and [[architecture#Layers]].\n`[[architecture]]`\n",
    "Backend.md": "Uses [[ architecture ]] and [[docs/other]].\n",
    "docs/other.md": "x\n",
  };

  it("rewrites plain, aliased and heading links, keeping the rest", () => {
    const plan = planLinkUpdates(notes, [["architecture.md", "system-design.md"]]);
    expect(plan.total).toBe(4);
    expect(plan.files).toEqual([{ path: "Ideas.md", count: 3 }, { path: "Backend.md", count: 1 }]);
    expect(plan.rewrite(notes["Ideas.md"])).toBe("See [[system-design]] and [[system-design|the design]] and [[system-design#Layers]].\n`[[architecture]]`\n");
    expect(plan.rewrite(notes["Backend.md"])).toBe("Uses [[ system-design ]] and [[docs/other]].\n");
  });

  it("keeps path-qualified links qualified", () => {
    const plan = planLinkUpdates(notes, [["docs/other.md", "docs/renamed.md"]]);
    expect(plan.rewrite(notes["Backend.md"])).toBe("Uses [[ architecture ]] and [[docs/renamed]].\n");
  });

  it("uses the full path when the new plain name would be ambiguous", () => {
    const plan = planLinkUpdates({ "a/x.md": "", "b.md": "", "n.md": "[[b]]" }, [["b.md", "z/x.md"]]);
    expect(plan.rewrite("[[b]]")).toBe("[[z/x]]");
  });

  it("does nothing when the links stay valid", () => {
    expect(planLinkUpdates({ "a.md": "[[b]]", "b.md": "" }, [["b.md", "sub/b.md"]]).total).toBe(0);
  });
});

import { extractHeadings, sectionOf, slugHeading } from "./headings";
import { splitFrontmatter } from "./frontmatter";
import { extractTasks } from "./tasks";
import { findMention, linkFirstMention } from "./mentions";
import { applyTemplate, collectTemplates } from "./templates";

describe("headings", () => {
  const doc = "---\n# not a heading\n---\n# Top\ntext\n## Part *A*\na\n```\n# code\n```\n### Deep\nd\n## Part B\nb\n";
  it("lists headings outside code and frontmatter", () => {
    expect(extractHeadings(doc).map((h) => [h.level, h.text, h.slug])).toEqual([
      [1, "Top", "top"], [2, "Part *A*", "part-a"], [3, "Deep", "deep"], [2, "Part B", "part-b"],
    ]);
    expect(slugHeading("Olá, Mundo! (2)")).toBe("olá-mundo-2");
  });
  it("extracts a section up to the next heading of the same level", () => {
    expect(sectionOf(doc, "Part A")).toBe("a\n```\n# code\n```\n### Deep\nd");
    expect(sectionOf(doc, "part b")).toBe("b");
    expect(sectionOf(doc, "nope")).toBeNull();
  });
});

describe("frontmatter", () => {
  it("parses scalars, inline lists and dash lists", () => {
    const f = splitFrontmatter('---\nstatus: done\ntags: [a, "b c"]\nauthors:\n  - Ana\n  - Bo\nempty:\n---\n# Body\n');
    expect(f.data).toEqual({ status: "done", tags: ["a", "b c"], authors: ["Ana", "Bo"], empty: "" });
    expect(f.body).toBe("# Body\n");
    expect(splitFrontmatter("# x").hasFrontmatter).toBe(false);
  });
});

describe("tasks", () => {
  it("numbers checkboxes the way toggleCheckbox does", () => {
    const c = "- [ ] one\n```\n- [ ] code\n```\n  - [x] two\n> - [ ] three\n";
    const t = extractTasks(c);
    expect(t.map((x) => [x.index, x.text, x.done])).toEqual([[0, "one", false], [1, "two", true], [2, "three", false]]);
    expect(toggleCheckbox(c, 1)).toContain("  - [ ] two");
  });
});

describe("mentions", () => {
  it("finds plain mentions only, not links or code", () => {
    expect(findMention("see [[Alpha]] and `Alpha` and [Alpha](x.md)", ["Alpha"])).toBeNull();
    expect(findMention("an Alphabet of alpha beta", ["Alpha"])?.text).toBe("alpha");
  });
  it("links the first mention keeping the original text as alias", () => {
    expect(linkFirstMention("we met alpha today", ["Alpha"], "Alpha")).toBe("we met [[Alpha|alpha]] today");
    expect(linkFirstMention("Alpha rules", ["Alpha"], "Alpha")).toBe("[[Alpha]] rules");
  });
});

describe("templates", () => {
  it("fills variables and leaves unknown ones", () => {
    const d = new Date(2026, 0, 5, 9, 7);
    expect(applyTemplate("# {{title}} {{date}} {{ time }} {{x}}", "Plan", d)).toBe("# Plan 2026-01-05 09:07 {{x}}");
  });
  it("lists workspace templates before built-ins", () => {
    const t = collectTemplates({ "templates/Weekly.md": { content: "w" }, "a.md": { content: "" } });
    expect(t[0]).toMatchObject({ name: "Weekly", path: "templates/Weekly.md" });
    expect(t.length).toBe(4);
  });
});

describe("embeds and heading links", () => {
  const notes: Record<string, string> = {
    "a.md": "# A\n\n![[b]]\n\n![[c#Part]]\n\n[[b#Intro|see b]]\n",
    "b.md": "---\nk: v\n---\n# B\n\nbody of b\n\n![[a]]\n",
    "c.md": "# C\n\n## Part\n\nonly this\n\n## Other\n\nnot this\n",
  };
  const embed = (t: string) => (notes[`${t}.md`] ? { path: `${t}.md`, content: notes[`${t}.md`]! } : null);
  const html = renderMarkdown(notes["a.md"]!, { notePath: "a.md", embed });

  it("expands embeds, honours sections and survives cycles", () => {
    expect(html).toContain('class="embed"');
    expect(html).toContain("body of b");
    expect(html).not.toContain("k: v");
    expect(html).toContain("only this");
    expect(html).not.toContain("not this");
    // b embeds a, which would embed b again: the cycle stops instead of looping.
    expect((html.match(/class="embed"/g) ?? []).length).toBeLessThan(6);
  });

  it("keeps the heading on wiki links and tags headings", () => {
    expect(html).toContain('data-wiki="b"');
    expect(html).toContain('data-heading-target="Intro"');
    expect(html).toContain('data-heading="a"');
  });

  it("renders embeds as links when no resolver is given", () => {
    expect(renderMarkdown("![[b]]", { notePath: "x.md" })).toContain("↪ b");
  });
});

describe("search filters", () => {
  const idx = buildIndex([
    ["a.md", "---\nstatus: done\nowner: Ana\n---\n# Alpha\nhello #work"],
    ["b.md", "---\nstatus: draft\n---\n# Beta\nhello"],
    ["docs/c.md", "# Gamma\nhello #work"],
  ]);
  const find = (q: string) => searchNotes(idx, () => "", q).map((r) => r.path).sort();
  it("filters by property, tag, path and title, with or without text", () => {
    expect(find("status:done")).toEqual(["a.md"]);
    expect(find("status:d")).toEqual(["a.md", "b.md"]);
    expect(find("hello tag:work")).toEqual(["a.md", "docs/c.md"]);
    expect(find("path:docs")).toEqual(["docs/c.md"]);
    expect(find("title:beta owner:ana")).toEqual([]);
    expect(find("owner:ana hello")).toEqual(["a.md"]);
    expect(find("https://x")).toEqual([]);
  });
});

import { rewriteMarkdownLinks, relativePath } from "./mdLinks";

describe("markdown link rename", () => {
  it("computes relative paths", () => {
    expect(relativePath("", "a.md")).toBe("a.md");
    expect(relativePath("docs", "a.md")).toBe("../a.md");
    expect(relativePath("docs", "docs/x/b.md")).toBe("x/b.md");
    expect(relativePath("a/b", "a/c/d.md")).toBe("../c/d.md");
  });

  it("rewrites url, keeps text and title, skips code and external links", () => {
    const r = rewriteMarkdownLinks('[a](old.md "T") ![i](<my pic.png>) `[c](old.md)` [w](https://x.io/old.md)', (u) => (u === "old.md" ? "new.md" : u === "my pic.png" ? "p.png" : null));
    expect(r.content).toBe('[a](new.md "T") ![i](<p.png>) `[c](old.md)` [w](https://x.io/old.md)');
    expect(r.count).toBe(2);
  });

  it("updates [text](note.md) links when a note is renamed or moved", () => {
    const notes = { "a.md": "[b](b.md) and [b2](b.md#sec) and [x](docs/c.md)", "b.md": "", "docs/c.md": "[a](../a.md)" };
    const plan = planLinkUpdates(notes, [["b.md", "sub/beta.md"]]);
    expect(plan.rewrite(notes["a.md"], "a.md")).toBe("[b](sub/beta.md) and [b2](sub/beta.md#sec) and [x](docs/c.md)");
    expect(plan.total).toBe(2);
  });

  it("fixes the links of a note that itself moves", () => {
    const notes = { "a.md": "[b](b.md) ![p](img/p.png) [ext](https://e.com)", "b.md": "[a](a.md)" };
    const plan = planLinkUpdates(notes, [["a.md", "docs/a.md"]]);
    expect(plan.rewrite(notes["a.md"], "docs/a.md")).toBe("[b](../b.md) ![p](../img/p.png) [ext](https://e.com)");
    expect(plan.rewrite(notes["b.md"], "b.md")).toBe("[a](docs/a.md)");
  });

  it("does nothing for links that stay valid", () => {
    const notes = { "docs/a.md": "[b](b.md)", "docs/b.md": "" };
    expect(planLinkUpdates(notes, [["docs", "docs"]].map(() => ["docs/b.md", "docs/b.md"] as [string, string])).total).toBe(0);
  });
});

import { analyzeVault, suggestName } from "./health";

describe("vault health", () => {
  it("suggests the closest existing name", () => {
    expect(suggestName("architecure", ["architecture", "ideas"])).toBe("architecture");
    expect(suggestName("arch", ["architecture", "ideas"])).toBe("architecture");
    expect(suggestName("zzz", ["architecture", "ideas"])).toBeNull();
  });

  it("finds broken links, orphans and untitled notes", () => {
    const notes = {
      "a.md": "# A\n[[b]] [[architecure]] [[architecure]]",
      "b.md": "# B\n",
      "lonely.md": "# Lonely\n",
      "plain.md": "no heading [[a]]",
      "architecture.md": "# Architecture\n[[a]]",
      "templates/t.md": "[[nothing]]",
    };
    const idx = buildIndex(Object.entries(notes));
    const h = analyzeVault(notes, idx);
    expect(h.broken).toEqual([{ from: "a.md", target: "architecure", suggestion: "architecture" }]);
    expect(h.orphans).toEqual(["lonely.md"]);
    expect(h.untitled).toEqual(["plain.md"]);
  });
});

import { comboFromEvent, findConflict, formatCombo, isValidCombo, effectiveCombos } from "./shortcuts";

describe("shortcuts", () => {
  const ev = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  it("normalises key events", () => {
    expect(comboFromEvent(ev("k", { ctrlKey: true }))).toBe("Ctrl+K");
    expect(comboFromEvent(ev("K", { metaKey: true, shiftKey: true }))).toBe("Ctrl+Shift+K");
    expect(comboFromEvent(ev("ArrowLeft", { altKey: true }))).toBe("Alt+ArrowLeft");
    expect(comboFromEvent(ev("+", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+=");
    expect(comboFromEvent(ev("Control", { ctrlKey: true }))).toBe("");
  });
  it("validates, formats and detects conflicts", () => {
    expect(isValidCombo("Ctrl+K")).toBe(true);
    expect(isValidCombo("K")).toBe(false);
    expect(isValidCombo("Shift+K")).toBe(false);
    expect(formatCombo("Alt+ArrowLeft")).toBe("Alt + ←");
    expect(findConflict({}, "search", "Ctrl+K")?.id).toBe("palette");
    expect(findConflict({ palette: "Ctrl+J" }, "search", "Ctrl+K")).toBeNull();
    expect(effectiveCombos({ palette: "Ctrl+J" }).palette).toBe("Ctrl+J");
  });
});

import { decryptText, encryptText, isEncrypted } from "./crypto";

describe("note encryption", () => {
  it("round-trips text, including unicode and newlines", async () => {
    const plain = "# Segredo\n\nsenha do wifi: ação ✓\n- [ ] item\n";
    const enc = await encryptText(plain, "correct horse");
    expect(isEncrypted(enc)).toBe(true);
    expect(enc).not.toContain("Segredo");
    expect(await decryptText(enc, "correct horse")).toBe(plain);
  });

  it("uses a fresh salt and iv each time", async () => {
    expect(await encryptText("x", "p")).not.toBe(await encryptText("x", "p"));
  });

  it("rejects a wrong password and tampered or malformed text", async () => {
    const enc = await encryptText("hello", "pw");
    await expect(decryptText(enc, "nope")).rejects.toThrow("Wrong password");
    const lines = enc.trimEnd().split("\n");
    const last = lines.pop()!;
    const flipped = last.slice(0, -6) + (last.slice(-6, -5) === "A" ? "B" : "A") + last.slice(-5);
    await expect(decryptText([...lines, flipped].join("\n"), "pw")).rejects.toThrow("Wrong password");
    await expect(decryptText(enc.replace(last, "not base64!!"), "pw")).rejects.toThrow("Wrong password");
    await expect(decryptText("plain text", "pw")).rejects.toThrow("not encrypted");
  });
});

import { alignRects, distributeRects, snapRect } from "./align";

describe("align and snap", () => {
  const r = (id: string, x: number, y: number, w = 100, h = 50) => ({ id, x, y, w, h });
  it("aligns to edges and centres of the selection", () => {
    const rs = [r("a", 0, 0), r("b", 50, 100, 200, 80)];
    expect(alignRects(rs, "left")).toEqual({ a: { x: 0, y: 0 }, b: { x: 0, y: 100 } });
    expect(alignRects(rs, "right")).toEqual({ a: { x: 150, y: 0 }, b: { x: 50, y: 100 } });
    expect(alignRects(rs, "bottom")).toEqual({ a: { x: 0, y: 130 }, b: { x: 50, y: 100 } });
    expect(alignRects(rs, "hcenter").a.x).toBe(75);
    expect(alignRects([r("a", 0, 0)], "left")).toEqual({});
  });
  it("distributes with equal gaps and keeps the ends", () => {
    const out = distributeRects([r("a", 0, 0), r("b", 10, 0), r("c", 400, 0)], "x");
    expect(out).toEqual({ a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, c: { x: 400, y: 0 } });
    expect(distributeRects([r("a", 0, 0), r("b", 5, 0)], "x")).toEqual({});
  });
  it("snaps to the nearest edge or centre within the threshold", () => {
    const others = [r("o", 200, 100, 100, 50)];
    const s = snapRect(r("m", 195, 103), others, 6);
    expect(s).toEqual({ dx: 5, dy: -3, guideX: 200, guideY: 100 });
    expect(snapRect(r("m", 600, 300), others, 6)).toEqual({ dx: 0, dy: 0, guideX: null, guideY: null });
  });
});

import { dayKey, dayLabel, groupByDay } from "./timeline";
import { resolveLang, translate } from "./i18n";

describe("timeline", () => {
  it("groups by local day, newest first", () => {
    const at = (d: string) => new Date(d).getTime();
    const g = groupByDay([
      { path: "a", time: at("2026-03-01T09:00:00") },
      { path: "b", time: at("2026-03-02T23:00:00") },
      { path: "c", time: at("2026-03-02T08:00:00") },
    ]);
    expect(g.map((x) => [x.day, x.items.map((i) => i.path)])).toEqual([["2026-03-02", ["b", "c"]], ["2026-03-01", ["a"]]]);
  });
  it("labels today and yesterday", () => {
    const now = new Date("2026-03-05T12:00:00").getTime();
    expect(dayLabel(dayKey(now), now)).toBe("Today");
    expect(dayLabel(dayKey(now - 86_400_000), now)).toBe("Yesterday");
    expect(dayLabel("2026-01-02", now, "en-US")).toContain("2026");
  });
});

describe("i18n", () => {
  it("falls back to English and fills placeholders", () => {
    expect(translate("pt-BR", "Timeline")).toBe("Linha do tempo");
    expect(translate("pt-BR", "Not translated yet")).toBe("Not translated yet");
    expect(translate("en", "Hello {name}", { name: "Ana" })).toBe("Hello Ana");
  });
  it("resolves the automatic language from the system", () => {
    expect(resolveLang("auto", "pt-PT")).toBe("pt-BR");
    expect(resolveLang("auto", "de-DE")).toBe("en");
    expect(resolveLang("en", "pt-BR")).toBe("en");
  });
});

import { buildMindMap } from "./mindmap";

describe("mind map", () => {
  it("nests ## and ### under a single # root and lays them out left to right", () => {
    const m = buildMindMap("# Plan\n## A\n### A1\n### A2\n## B\n", "plan");
    expect(m.root.text).toBe("Plan");
    expect(m.root.children.map((c) => c.text)).toEqual(["A", "B"]);
    expect(m.root.children[0]!.children.map((c) => c.text)).toEqual(["A1", "A2"]);
    expect(m.nodes.map((n) => n.depth)).toEqual([0, 1, 2, 2, 1]);
    expect(m.links.length).toBe(4);
    // Leaves take consecutive rows; parents sit in the middle of their children.
    expect(m.root.children[0]!.y).toBe((m.root.children[0]!.children[0]!.y + m.root.children[0]!.children[1]!.y) / 2);
    expect(m.height).toBe(3 * 44);
  });
  it("uses the note title as root when there are several top headings", () => {
    const m = buildMindMap("# One\n# Two\n## Sub\n", "my-note");
    expect(m.root.text).toBe("my-note");
    expect(m.root.children.map((c) => c.text)).toEqual(["One", "Two"]);
    expect(buildMindMap("no headings", "x").nodes.length).toBe(1);
  });
});

import { buildBoardHtml, inlineAssets } from "./exportBoard";
import { emptyBoard } from "./board";

describe("mural export", () => {
  const board = { ...emptyBoard(), cards: { "a.md": { x: 100, y: 100, w: 280, h: 200, color: "yellow" as const }, "b.md": { x: 600, y: 140, w: 280, h: 200, color: "paper" as const } }, frames: [{ id: "f1", title: "Ideas <x>", color: "paper" as const, x: 60, y: 60, w: 900, h: 320 }], labels: { "auto:a.md->b.md": "next" } };
  const html = buildBoardHtml({
    title: "My <mural>",
    board,
    cards: [{ path: "a.md", title: "Alpha", html: "<p>hello</p>" }, { path: "b.md", title: "Beta & co", html: "" }],
    edges: [{ id: "auto:a.md->b.md", source: "a.md", target: "b.md" }, { id: "x", source: "a.md", target: "missing.md" }],
    theme: "dark",
  });
  it("is a single page with escaped titles, positioned cards, frame and one arrow", () => {
    expect(html).toContain("<title>My &lt;mural&gt;</title>");
    expect(html).toContain("Beta &amp; co");
    expect(html).toContain("Ideas &lt;x&gt;");
    expect(html).toContain("<p>hello</p>");
    expect((html.match(/<article/g) ?? []).length).toBe(2);
    expect((html.match(/class="edge"/g) ?? []).length).toBe(2); // curve + arrow head of the one valid edge
    expect(html).toContain(">next</text>");
    expect(html).toContain("Content-Security-Policy");
  });
  it("inlines assets and drops the ones it cannot read", () => {
    const out = inlineAssets('<img src="bmnotes://localhost/assets/a%20b.png"><img src="bmnotes://localhost/x.png">', (p) => (p === "assets/a b.png" ? "data:image/png;base64,AAA" : null));
    expect(out).toContain('src="data:image/png;base64,AAA"');
    expect(out).toContain('alt="image not included"');
  });
});

import { protectCurrency } from "./mathGuard";
import { dueSummary, extractDates, monthGrid } from "./dates";

describe("math guard", () => {
  it("escapes prices but keeps real maths", () => {
    expect(protectCurrency("costs $5 and $6")).toBe("costs \\$5 and \\$6");
    expect(protectCurrency("price $5, formula $x^2$ ok")).toBe("price \\$5, formula $x^2$ ok");
    expect(protectCurrency("$a$ and $b$")).toBe("$a$ and $b$");
    expect(protectCurrency("a lone $ sign")).toBe("a lone \\$ sign");
    expect(protectCurrency("$$\nx = 1\n$$")).toBe("$$\nx = 1\n$$");
    expect(protectCurrency("`$5 and $6`")).toBe("`$5 and $6`");
  });
  it("renders maths and leaves prices as text", () => {
    const html = renderMarkdown("Euler: $e^{i\\pi}+1=0$, it costs $5 and $6.\n\n$$\\sum_{i=1}^n i$$\n", { notePath: "a.md" });
    expect(html).toContain("katex");
    expect(html).toContain("it costs $5 and $6");
  });
});

describe("dates", () => {
  const note = "# Plan\n- [ ] file taxes @2026-04-15\n- [x] book flights @2026-03-01 09:30\nmeeting on @2026-02-30 (not real)\n`@2026-05-05` in code\nemail a@2026-05-05.com\nplain note @2026-06-01\n";
  it("finds real dates, times and task status; ignores code and emails", () => {
    expect(extractDates(note).map((d) => [d.date, d.time, d.taskIndex, d.done])).toEqual([
      ["2026-04-15", null, 0, false],
      ["2026-03-01", "09:30", 1, true],
      ["2026-06-01", null, null, false],
    ]);
  });
  it("summarises open tasks due today or earlier", () => {
    expect(dueSummary({ "a.md": note }, "2026-04-15")).toEqual({ overdue: 0, today: 1 });
    expect(dueSummary({ "a.md": note }, "2026-05-01")).toEqual({ overdue: 1, today: 0 });
  });
  it("builds month grids", () => {
    const w = monthGrid(2026, 1, 0); // February 2026 starts on a Sunday
    expect(w[0]![0]).toBe("2026-02-01");
    expect(w.flat().filter(Boolean).length).toBe(28);
    expect(monthGrid(2026, 2, 1)[0]!.slice(0, 6).every((c) => c === null)).toBe(true); // March 1st 2026 is a Sunday: last column on a Monday-first grid
  });
});

import { emptyTable, findTableAt, parseTable, serializeTable } from "./mdTable";

describe("markdown tables", () => {
  const md = "| Name | Qty | Note |\n|:--|--:|:-:|\n| apple | 3 | a \\| b |\n| pear | 10 | |";
  it("parses cells, alignment and escaped pipes", () => {
    const t = parseTable(md)!;
    expect(t.header).toEqual(["Name", "Qty", "Note"]);
    expect(t.align).toEqual(["left", "right", "center"]);
    expect(t.rows).toEqual([["apple", "3", "a \\| b"], ["pear", "10", ""]]);
    expect(parseTable("just text")).toBeNull();
  });
  it("round-trips through serialize with aligned columns", () => {
    const t = parseTable(md)!;
    const out = serializeTable(t);
    expect(parseTable(out)).toEqual(t);
    expect(out.split("\n").every((l) => l.length === out.split("\n")[0]!.length)).toBe(true);
    expect(parseTable(serializeTable(emptyTable()))!.rows.length).toBe(2);
  });
  it("finds the table around the cursor", () => {
    const doc = "intro\n\n" + md + "\n\nafter | not a table";
    const pos = doc.indexOf("apple");
    const f = findTableAt(doc, pos)!;
    expect(f.text).toBe(md);
    expect(doc.slice(f.from, f.to)).toBe(md);
    expect(findTableAt(doc, 2)).toBeNull();
    expect(findTableAt(doc, doc.indexOf("after"))).toBeNull();
  });
});

import { attachmentMarkdown } from "./images";

describe("attachments", () => {
  it("renders audio as a player and pdf as an openable link", () => {
    const html = renderMarkdown("![clip](sub/a%20b.mp3)\n\n[Doc](../d.pdf)\n\n![pic](p.png)", { notePath: "n/x.md" });
    expect(html).toContain("<audio");
    expect(html).toContain("controls");
    expect(html).toContain('data-attachment="d.pdf"');
    expect(html).toContain("<img");
  });
  it("builds the right markdown per file type", () => {
    expect(attachmentMarkdown("assets/p.png", "p")).toBe("![](assets/p.png)");
    expect(attachmentMarkdown("assets/Voice memo.webm", "Voice memo")).toBe("![Voice memo](assets/Voice%20memo.webm)");
    expect(attachmentMarkdown("../assets/d.pdf", "Doc")).toBe("[Doc](../assets/d.pdf)");
  });
});

import { COMMAND_TIMEOUT_MS, PluginHost, sha256Hex, type HostApi, type WorkerLike } from "./plugins/host";

describe("plugin host", () => {
  class FakeWorker implements WorkerLike {
    sent: Record<string, unknown>[] = [];
    source = "";
    terminated = false;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    postMessage(m: unknown) { this.sent.push(m as Record<string, unknown>); }
    terminate() { this.terminated = true; }
    emit(data: unknown) { this.onmessage?.({ data }); }
  }
  const setup = () => {
    const writes: [string, string][] = [];
    const toasts: string[] = [];
    const fails: string[] = [];
    const api: HostApi = {
      listNotes: () => [{ path: "a.md", title: "A" }],
      readNote: (p) => (p === "a.md" ? "hello" : null),
      writeNote: (p, c) => void writes.push([p, c]),
      createNote: async (n) => `${n}.md`,
      openNote: () => {},
      prompt: async () => "typed",
      toast: (m) => void toasts.push(m),
    };
    const w = new FakeWorker();
    const cmds: string[] = [];
    const host = new PluginHost("demo", "bmnotes.toast('hi')", api, (src) => { w.source = src; return w; }, (c) => cmds.push(c.id), (m) => fails.push(m));
    host.start();
    return { w, host, writes, toasts, fails, cmds };
  };

  it("loads the plugin after the bootstrap with no network and the bm api", () => {
    const { w } = setup();
    expect(w.source).toContain("self.bmnotes = Object.freeze");
    expect(w.source).toContain('"fetch"');
    expect(w.source.indexOf("bmnotes.toast('hi')")).toBeGreaterThan(w.source.indexOf("self.bm"));
  });

  it("registers commands, serves note calls and forwards toasts", async () => {
    const { w, host, writes, toasts, cmds } = setup();
    w.emit({ t: "command", id: "go", label: "Go" });
    w.emit({ t: "command", id: "go", label: "Again" });
    expect(cmds).toEqual(["go"]);
    w.emit({ t: "toast", msg: "hello" });
    expect(toasts).toEqual(["hello"]);
    w.emit({ t: "call", id: 1, op: "list", args: {} });
    w.emit({ t: "call", id: 2, op: "read", args: { path: "missing.md" } });
    w.emit({ t: "call", id: 3, op: "write", args: { path: "a.md", content: "x" } });
    w.emit({ t: "call", id: 4, op: "nope", args: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.sent.find((m) => m.id === 1)!.value).toEqual([{ path: "a.md", title: "A" }]);
    expect(w.sent.find((m) => m.id === 2)!.error).toBe("No such note");
    expect(writes).toEqual([["a.md", "x"]]);
    expect(w.sent.find((m) => m.id === 4)!.error).toBe("Unknown call");
    const p = host.run("go");
    const run = w.sent.find((m) => m.t === "run")!;
    w.emit({ t: "done", rid: run.rid });
    await expect(p).resolves.toBeUndefined();
  });

  it("stops a plugin whose command never finishes", async () => {
    vi.useFakeTimers();
    const { w, host, fails } = setup();
    const p = host.run("slow");
    p.catch(() => {});
    vi.advanceTimersByTime(COMMAND_TIMEOUT_MS + 1);
    await expect(p).rejects.toThrow("timeout");
    expect(w.terminated).toBe(true);
    expect(fails[0]).toContain("longer than 10s");
    vi.useRealTimers();
  });

  it("hashes code for approval", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

import { firstCard, nearestInDirection } from "./boardNav";

describe("keyboard navigation of the mural", () => {
  const r = (id: string, x: number, y: number) => ({ id, x, y, w: 100, h: 60 });
  const cards = [r("a", 0, 0), r("b", 300, 10), r("c", 300, 200), r("d", 600, 0), r("e", 0, 300)];
  it("moves to the nearest card in the arrow direction", () => {
    expect(nearestInDirection(cards[0]!, cards, "right")).toBe("b");
    expect(nearestInDirection(cards[1]!, cards, "right")).toBe("d");
    expect(nearestInDirection(cards[1]!, cards, "left")).toBe("a");
    expect(nearestInDirection(cards[0]!, cards, "down")).toBe("e");
    expect(nearestInDirection(cards[2]!, cards, "up")).toBe("b");
  });
  it("returns null when nothing is that way, and picks the top-left first", () => {
    expect(nearestInDirection(cards[0]!, cards, "left")).toBeNull();
    expect(nearestInDirection(cards[3]!, cards, "right")).toBeNull();
    expect(firstCard(cards)).toBe("a");
    expect(firstCard([])).toBeNull();
  });
});

describe("large folders", () => {
  it("indexes and searches thousands of notes quickly (generous limits to avoid flakiness)", () => {
    const N = 5000;
    const entries: [string, string][] = Array.from({ length: N }, (_, i) => [`dir${i % 50}/note-${i}.md`, `# Note ${i}\n\nSome text about topic ${i % 97} #tag${i % 31} with [[note-${(i * 7) % N}]] and more words to read.\n`.repeat(4)]);
    const t0 = performance.now();
    const idx = buildIndex(entries);
    const built = performance.now() - t0;
    const t1 = performance.now();
    const hits = searchNotes(idx, () => "", "topic 42 tag7");
    const searched = performance.now() - t1;
    expect(idx.meta.size).toBe(N);
    expect(hits.length).toBeGreaterThan(0);
    expect(built).toBeLessThan(8000);
    expect(searched).toBeLessThan(1500);
  });
});

import { PT_BR } from "./locales/pt-BR";

describe("translations", () => {
  const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  it("keep the same {placeholders} as the English text", () => {
    for (const [k, v] of Object.entries(PT_BR)) expect(holes(v), k).toBe(holes(k));
  });
  it("have no empty translations", () => {
    expect(Object.values(PT_BR).every((v) => v.trim().length > 0)).toBe(true);
  });
});
