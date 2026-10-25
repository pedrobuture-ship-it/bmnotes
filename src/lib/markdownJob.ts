import { renderMarkdown } from "./markdown";
import { createResolver } from "./wikiResolve";

export interface MarkdownJob {
  path: string;
  content: string;
  interactive: boolean;
  paths: string[];
  sources: [string, string][];
  embeds: boolean;
  today: string;
}

export function renderMarkdownJob(job: MarkdownJob): string {
  const resolver = createResolver(job.paths);
  const sources = new Map(job.sources);
  return renderMarkdown(job.content, {
    notePath: job.path,
    interactiveTasks: job.interactive,
    today: job.today,
    resolves: (target) => resolver.resolve(target) !== null,
    embed: job.embeds ? (target) => {
      const path = resolver.resolve(target);
      const content = path ? sources.get(path) : undefined;
      return path && content !== undefined ? { path, content } : null;
    } : undefined,
  });
}
