import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { dayKey } from "@/lib/timeline";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { WorkerQueue } from "@/lib/workerQueue";
import type { MarkdownJob } from "@/lib/markdownJob";
import type { NoteIndex } from "@/lib/noteIndex";
import type { NoteState } from "@/stores/workspace";
import { isEncrypted } from "@/lib/crypto";
import { toggleCheckbox } from "@/lib/markdownText";
import { ipc } from "@/lib/ipc";
import { openWikiLink } from "@/lib/actions";
import { useWorkspace } from "@/stores/workspace";

const renderer = new WorkerQueue<MarkdownJob, string>(() => new Worker(new URL("../../workers/markdown.worker.ts", import.meta.url), { type: "module" }));
const cache = new Map<string, string>();
let cacheSize = 0;
const resolverIds = new WeakMap<NoteIndex["resolver"], number>();
let nextResolverId = 0;
function resolverId(resolver: NoteIndex["resolver"]): number {
  if (!resolverIds.has(resolver)) resolverIds.set(resolver, ++nextResolverId);
  return resolverIds.get(resolver)!;
}

/** Only embedded notes (including nested sources), rather than the entire vault. */
function embeddedSources(content: string, notes: Record<string, NoteState>, resolver: NoteIndex["resolver"]): string {
  const sources = new Map<string, string>();
  function collect(text: string, depth: number) {
    if (depth >= 2) return;
    for (const m of text.matchAll(/!\[\[([^[\]\n|#]+)/g)) {
      const path = resolver.resolve((m[1] ?? "").trim());
      const note = path ? notes[path] : undefined;
      if (!path || !note || isEncrypted(note.content) || sources.has(path)) continue;
      sources.set(path, note.content);
      collect(note.content, depth + 1);
    }
  }
  collect(content, 0);
  return JSON.stringify([...sources]);
}

function remember(key: string, html: string) {
  cacheSize -= cache.has(key) ? key.length + cache.get(key)!.length : 0;
  cache.delete(key);
  cache.set(key, html);
  cacheSize += key.length + html.length;
  // Bound memory by characters as well as entry count (typing creates new revisions).
  while (cache.size > 400 || cacheSize > 4_000_000) {
    const first = cache.keys().next().value!;
    cacheSize -= first.length + cache.get(first)!.length;
    cache.delete(first);
  }
}

interface Props {
  path: string;
  content: string;
  interactive?: boolean;
  /** Expand `![[note]]` embeds (note pages do; cards keep them as links). */
  embeds?: boolean;
  className?: string;
  /** Called for clicks that aren't links/checkboxes (cards use it for selection). */
  onPlainClick?: (e: MouseEvent) => void;
}

/** Rendered Markdown. Wiki links open notes; task checkboxes edit the real file. */
export const Preview = memo(function Preview({ path, content, interactive = true, embeds = false, className = "", onPlainClick }: Props) {
  const locked = isEncrypted(content);
  const resolver = useWorkspace((s) => s.index.resolver);
  const sources = useWorkspace((s) => embeds && !locked ? embeddedSources(content, s.notes, s.index.resolver) : "[]");
  const today = dayKey(Date.now());
  const key = useMemo(() => JSON.stringify([path, content, interactive, embeds, resolverId(resolver), sources, today]), [path, content, interactive, embeds, resolver, sources, today]);
  const [rendered, setRendered] = useState<{ key: string; path: string; html: string; failed?: boolean } | null>(null);
  const html = cache.get(key) ?? (rendered?.key === key ? rendered.html : (rendered?.path === path ? rendered.html : ""));
  const pending = !cache.has(key) && rendered?.key !== key;
  useEffect(() => {
    if (locked || cache.has(key)) return;
    let cancelled = false;
    let job: ReturnType<typeof renderer.submit> | undefined;
    const timer = setTimeout(() => {
      job = renderer.submit({ path, content, interactive, embeds, paths: [...useWorkspace.getState().index.meta.keys()], sources: JSON.parse(sources), today });
      job.promise.then((html) => {
        if (cancelled) return;
        remember(key, html);
        setRendered({ key, path, html });
      }).catch(() => {
        if (!cancelled) setRendered({ key, path, html: "", failed: true });
      });
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); job?.cancel(); };
  }, [key, locked, path, content, interactive, embeds, sources, today]);

  const ref = useRef<HTMLDivElement>(null);
  const theme = useSettings((s) => s.settings.appearance.theme);

  // ```mermaid blocks become diagrams (note pages only; cards keep the code). The library loads on first use.
  useEffect(() => {
    const root = ref.current;
    if (!embeds || locked || !root) return;
    const blocks = [...root.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
    if (blocks.length === 0) return;
    let cancelled = false;
    void (async () => {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme === "dark" ? "dark" : "default" });
      for (const [i, code] of blocks.entries()) {
        const pre = code.parentElement;
        if (!pre || !pre.isConnected) continue;
        try {
          const { svg } = await mermaid.render(`mmd-${Math.random().toString(36).slice(2, 8)}-${i}`, code.textContent ?? "");
          if (cancelled || !pre.isConnected) return;
          const holder = document.createElement("div");
          holder.className = "mermaid-diagram";
          holder.innerHTML = svg;
          pre.replaceWith(holder);
        } catch (e) {
          pre.classList.add("mermaid-error");
          pre.title = e instanceof Error ? e.message.split("\n")[0] ?? "Diagram error" : "Diagram error";
          document.querySelectorAll("[id^='dmmd-']").forEach((n) => n.remove());
        }
      }
    })();
    return () => { cancelled = true; };
  }, [html, embeds, locked, theme]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const checkbox = target.closest<HTMLInputElement>("input[type=checkbox][data-task]");
    if (checkbox && interactive) {
      if (pending) { e.preventDefault(); return; }
      e.preventDefault();
      const idx = Number(checkbox.dataset.task);
      const ws = useWorkspace.getState();
      const cur = ws.notes[path]?.content;
      if (cur !== undefined) {
        const next = toggleCheckbox(cur, idx);
        if (next !== null) ws.setContent(path, next);
      }
      return;
    }
    const a = target.closest<HTMLAnchorElement>("a");
    if (a) {
      e.preventDefault();
      const wiki = a.dataset.wiki;
      const href = a.getAttribute("href") ?? "";
      if (a.dataset.attachment) void ipc.openAttachment(a.dataset.attachment).catch((err) => useUi.getState().toast(err instanceof Error ? err.message : String(err), "error"));
      else if (wiki) void openWikiLink(wiki, a.dataset.headingTarget);
      else if (/^(https?:|mailto:)/i.test(href)) void ipc.openExternal(href);
      return;
    }
    onPlainClick?.(e);
  };

  if (locked) return <p className={`m-0 ${className}`} style={{ opacity: 0.7 }}>🔒 Encrypted note. Open it to unlock.</p>;
  if (rendered?.key === key && rendered.failed) return <pre className={`selectable ${className}`}>{content}</pre>;
  return <div aria-busy={pending} ref={ref} className={`md-prose selectable ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
