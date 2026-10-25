import { layoutGraph, type GraphInput } from "../lib/graphLayout";
self.onmessage = (event: MessageEvent<{ id: number; input: GraphInput }>) => {
  const { id, input } = event.data;
  try { self.postMessage({ id, result: layoutGraph(input) }); }
  catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
};
