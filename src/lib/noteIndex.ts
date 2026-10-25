import { basename, stripExt } from "./paths";
import { extractTags, extractTitle, extractWikiLinks } from "./markdownText";
import { createResolver, type LinkResolver } from "./wikiResolve";
import { splitFrontmatter, type PropValue } from "./frontmatter";

export interface NoteMeta {
  path: string;
  name: string;
  title: string;
  tags: string[];
  /** Frontmatter properties, keys lowercased. */
  props: Record<string, PropValue>;
  /** Raw wiki-link targets as written. */
  rawLinks: string[];
  /** Resolved outgoing links (note paths). */
  links: string[];
  lower: string;
}

export interface NoteIndex {
  meta: Map<string, NoteMeta>;
  backlinks: Map<string, string[]>;
  tags: Map<string, string[]>;
  /** Resolves a wiki-link target to a note path (built once per index). */
  resolver: LinkResolver;
}

export function parseNote(path: string, content: string): Omit<NoteMeta, "links"> {
  const name = stripExt(basename(path));
  return {
    path,
    name,
    title: extractTitle(content, name),
    tags: extractTags(content),
    props: Object.fromEntries(Object.entries(splitFrontmatter(content).data).map(([k, v]) => [k.toLowerCase(), v])),
    rawLinks: extractWikiLinks(content).map((l) => l.target),
    lower: content.toLowerCase(),
  };
}

export function buildIndex(notes: Map<string, string> | Iterable<[string, string]>): NoteIndex {
  const parsed = new Map<string, Omit<NoteMeta, "links">>();
  for (const [path, content] of notes) parsed.set(path, parseNote(path, content));
  return linkIndex(parsed);
}

export function linkIndex(parsed: Map<string, Omit<NoteMeta, "links">>, resolver = createResolver([...parsed.keys()])): NoteIndex {
  const meta = new Map<string, NoteMeta>();
  const backlinks = new Map<string, string[]>();
  const tags = new Map<string, string[]>();
  for (const [path, p] of parsed) {
    const links = [...new Set(p.rawLinks.map((l) => resolver.resolve(l)).filter((x): x is string => !!x && x !== path))];
    meta.set(path, { ...p, links });
    for (const target of links) {
      const arr = backlinks.get(target);
      if (arr) arr.push(path);
      else backlinks.set(target, [path]);
    }
    for (const t of p.tags) {
      const arr = tags.get(t);
      if (arr) arr.push(path);
      else tags.set(t, [path]);
    }
  }
  return { meta, backlinks, tags, resolver };
}

/**
 * Incremental update: only the changed note is re-parsed; link resolution and
 * backlinks are cheap to recompute from the cached per-note parse results.
 */
export function updateIndex(prev: NoteIndex, changes: { path: string; content: string | null }[]): NoteIndex {
  const parsed = new Map<string, Omit<NoteMeta, "links">>();
  for (const [path, m] of prev.meta) {
    const { links: _l, ...rest } = m;
    parsed.set(path, rest);
  }
  for (const c of changes) {
    if (c.content === null) parsed.delete(c.path);
    else parsed.set(c.path, parseNote(c.path, c.content));
  }
  const samePaths = parsed.size === prev.meta.size && [...parsed.keys()].every((path) => prev.meta.has(path));
  return linkIndex(parsed, samePaths ? prev.resolver : undefined);
}
