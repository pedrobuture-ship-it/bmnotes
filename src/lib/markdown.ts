import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options as Schema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Options as KatexOptions } from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import type { Root as MdRoot, Text, PhrasingContent, Parent } from "mdast";
import type { Root as HRoot, Element } from "hast";
import { visit, SKIP } from "unist-util-visit";
import { dirname, resolveRelative } from "./paths";
import { slugHeading, sectionOf } from "./headings";
import { splitFrontmatter } from "./frontmatter";
import { protectCurrency } from "./mathGuard";
import { DATE_TOKEN, isRealDate } from "./dates";

const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
const ASSET_BASE = isWindows ? "http://bmnotes.localhost/" : "bmnotes://localhost/";

export function assetUrl(relPath: string): string {
  return ASSET_BASE + relPath.split("/").map(encodeURIComponent).join("/");
}

const WIKI = /(!?)\[\[([^[\]\n|#]+)(?:#([^[\]\n|]*))?(?:\|([^[\]\n]*))?\]\]/g;
const EMBED_ONLY = /^!\[\[([^[\]\n|#]+)(?:#([^[\]\n|]*))?(?:\|([^[\]\n]*))?\]\]$/;
const MAX_EMBED_DEPTH = 2;

export interface EmbedSource {
  path: string;
  content: string;
}

const wikiHref = (target: string, heading?: string) => `#wiki:${encodeURIComponent(target)}${heading ? `#${encodeURIComponent(heading)}` : ""}`;

/** Replaces a paragraph that is just `![[note]]` or `![[note#Section]]` with the embedded content. */
function remarkEmbeds(embed?: (target: string) => EmbedSource | null) {
  const parseMd = (text: string): MdRoot => unified().use(remarkParse).use(remarkGfm).parse(text) as MdRoot;
  const expand = (tree: MdRoot, depth: number, seen: Set<string>) => {
    visit(tree, "paragraph", (node, index, parent: Parent | undefined) => {
      if (!parent || index === undefined || node.children.length !== 1) return;
      const only = node.children[0];
      const m = only?.type === "text" ? EMBED_ONLY.exec(only.value.trim()) : null;
      if (!m) return;
      const target = (m[1] ?? "").trim();
      const heading = (m[2] ?? "").trim();
      const src = depth < MAX_EMBED_DEPTH ? embed?.(target) : null;
      if (!src || seen.has(src.path)) return;
      let body = splitFrontmatter(src.content).body;
      if (heading) body = sectionOf(body, heading) ?? "";
      const inner = parseMd(body);
      expand(inner, depth + 1, new Set(seen).add(src.path));
      const label = (m[3] ?? "").trim() || (heading ? `${target} › ${heading}` : target);
      parent.children.splice(index, 1, {
        type: "blockquote",
        data: { hName: "div", hProperties: { className: ["embed"] } },
        children: [
          { type: "paragraph", children: [{ type: "link", url: wikiHref(target, heading), children: [{ type: "text", value: `↪ ${label}` }] }] },
          ...inner.children,
        ],
      } as never);
      return [SKIP, index + 1];
    });
  };
  return (tree: MdRoot) => expand(tree, 0, new Set());
}

/** Turns `[[target|alias]]` in text nodes into links with a `#wiki:` href. */
function remarkWikiLinks() {
  return (tree: MdRoot) => {
    visit(tree, "text", (node: Text, index, parent: Parent | undefined) => {
      if (!parent || index === undefined || !node.value.includes("[[")) return;
      const parts: PhrasingContent[] = [];
      let last = 0;
      for (const m of node.value.matchAll(WIKI)) {
        const at = m.index ?? 0;
        if (at > last) parts.push({ type: "text", value: node.value.slice(last, at) });
        const target = (m[2] ?? "").trim();
        const heading = (m[3] ?? "").trim();
        const label = (m[4] ?? "").trim() || target;
        parts.push({
          type: "link",
          url: wikiHref(target, heading),
          children: [{ type: "text", value: m[1] ? `↪ ${label}` : label }],
        });
        last = at + m[0].length;
      }
      if (parts.length === 0) return;
      if (last < node.value.length) parts.push({ type: "text", value: node.value.slice(last) });
      parent.children.splice(index, 1, ...parts);
      return [SKIP, index + parts.length];
    });
  };
}

interface RehypeOpts {
  /** Today as YYYY-MM-DD, used to colour `@date` chips. */
  today: string;
  notePath: string;
  interactiveTasks: boolean;
  resolves: (target: string) => boolean;
}

function rehypeNoteFeatures(opts: RehypeOpts) {
  return (tree: HRoot) => {
    let taskIndex = 0;
    const noteDir = dirname(opts.notePath);
    visit(tree, "element", (node: Element, index, parent) => {
      if (parent && index !== undefined && (parent as Element).tagName !== "code" && (parent as Element).tagName !== "pre") dueChips(node, opts.today);
      if (node.tagName === "input" && node.properties?.type === "checkbox") {
        node.properties["data-task"] = String(taskIndex++);
        if (opts.interactiveTasks) delete node.properties.disabled;
        else node.properties.disabled = true;
      }
      if (node.tagName === "img" && typeof node.properties?.src === "string") {
        const src = node.properties.src;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//")) {
          const decoded = safeDecode(src);
          const resolved = decoded.startsWith("/") ? decoded.slice(1) : resolveRelative(noteDir, decoded);
          if (resolved) node.properties.src = assetUrl(resolved);
          else delete node.properties.src;
        }
        node.properties.loading = "lazy";
        const shown = typeof node.properties.src === "string" ? node.properties.src : "";
        if (/\.(mp3|wav|ogg|oga|opus|m4a|aac|webm|flac)(\?|#|$)/i.test(shown)) {
          // `![](x.mp3)` is a player, not a picture.
          node.tagName = "audio";
          node.properties = { src: shown, controls: true, preload: "metadata", "data-name": String(node.properties.alt ?? "") };
          node.children = [];
        }
      }
      if (node.tagName === "a" && typeof node.properties?.href === "string" && /\.(pdf|mp3|wav|ogg|oga|opus|m4a|aac|webm|flac)([?#].*)?$/i.test(node.properties.href) && !/^[a-z][a-z0-9+.-]*:/i.test(node.properties.href)) {
        const href = safeDecode(node.properties.href.split(/[?#]/)[0] ?? "");
        const resolved = href.startsWith("/") ? href.slice(1) : resolveRelative(noteDir, href);
        if (resolved) {
          node.properties["data-attachment"] = resolved;
          node.properties.className = ["attachment"];
        }
      }
      if (/^h[1-6]$/.test(node.tagName)) node.properties = { ...node.properties, "data-heading": slugHeading(hastText(node)) };
      if (node.tagName === "a" && typeof node.properties?.href === "string" && node.properties.href.startsWith("#wiki:")) {
        const rest = node.properties.href.slice(6);
        const hash = rest.indexOf("#");
        const target = safeDecode(hash === -1 ? rest : rest.slice(0, hash));
        if (hash !== -1) node.properties["data-heading-target"] = safeDecode(rest.slice(hash + 1));
        node.properties["data-wiki"] = target;
        node.properties.className = opts.resolves(target) ? ["wikilink"] : ["wikilink", "wikilink-missing"];
      }
    });
  };
}

/** Turns `@2026-11-01` inside the text children of `el` into `<span class="due">` chips. */
function dueChips(el: Element, today: string) {
  if (el.tagName === "code" || el.tagName === "pre" || !el.children.some((c) => c.type === "text" && c.value.includes("@"))) return;
  const next: Element["children"] = [];
  for (const c of el.children) {
    if (c.type !== "text" || !c.value.includes("@")) {
      next.push(c);
      continue;
    }
    let last = 0;
    for (const m of c.value.matchAll(DATE_TOKEN)) {
      if (!isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) continue;
      const date = `${m[1]}-${m[2]}-${m[3]}`;
      if (m.index > last) next.push({ type: "text", value: c.value.slice(last, m.index) });
      const cls = date < today ? "due-past" : date === today ? "due-today" : "due-later";
      next.push({ type: "element", tagName: "span", properties: { className: ["due", cls], "data-date": date }, children: [{ type: "text", value: m[0] }] });
      last = m.index + m[0].length;
    }
    if (last === 0) next.push(c);
    else if (last < c.value.length) next.push({ type: "text", value: c.value.slice(last) });
  }
  el.children = next;
}

function hastText(node: Element | { children?: unknown[]; value?: string }): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  return ((node.children ?? []) as (Element | { value?: string })[]).map((c) => hastText(c as Element)).join("");
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const schema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^(hljs|language-.*|math-inline|math-display)$/]],
    span: [...(defaultSchema.attributes?.span ?? []), ["className", /^hljs.*$/]],
    input: [...(defaultSchema.attributes?.input ?? []), "checked", "disabled", "type"],
    div: [...(defaultSchema.attributes?.div ?? []), ["className", "embed"]],
  },
  protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), "mailto"] },
  clobber: [],
};

export interface RenderOptions {
  notePath: string;
  interactiveTasks?: boolean;
  resolves?: (target: string) => boolean;
  /** Looks up a note for `![[note]]` embeds. Without it, embeds render as plain links. */
  embed?: (target: string) => EmbedSource | null;
  /** `html` (default) needs the KaTeX stylesheet; `mathml` works anywhere (used for exports). */
  math?: "html" | "mathml";
  /** Today as YYYY-MM-DD; defaults to the system date. */
  today?: string;
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function renderMarkdown(content: string, options: RenderOptions): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkEmbeds, options.embed)
    .use(remarkWikiLinks)
    .use(remarkRehype)
    .use(rehypeSanitize, schema)
    .use(rehypeKatex, { output: options.math === "mathml" ? "mathml" : "htmlAndMathml", strict: "ignore", trust: false, throwOnError: false } as KatexOptions)
    .use(rehypeHighlight, { detect: false, ignoreMissing: true })
    .use(rehypeNoteFeatures, {
      today: options.today ?? localToday(),
      notePath: options.notePath,
      interactiveTasks: options.interactiveTasks ?? false,
      resolves: options.resolves ?? (() => true),
    })
    .use(rehypeStringify);
  return String(processor.processSync(protectCurrency(content)));
}
