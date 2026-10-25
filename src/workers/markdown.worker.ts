import { renderMarkdownJob, type MarkdownJob } from "../lib/markdownJob";
self.onmessage = (event: MessageEvent<{ id: number; input: MarkdownJob }>) => {
  const { id, input } = event.data;
  try { self.postMessage({ id, result: renderMarkdownJob(input) }); }
  catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
};
