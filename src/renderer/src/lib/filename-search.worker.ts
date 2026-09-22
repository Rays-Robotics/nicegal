import { searchFilenames, type FilenameEntry } from "./filename-search";

type Request =
  | { kind: "catalog"; entries: FilenameEntry[] }
  | { kind: "search"; id: number; query: string };

let entries: FilenameEntry[] = [];

self.onmessage = (event: MessageEvent<Request>): void => {
  const request = event.data;
  if (request.kind === "catalog") {
    entries = request.entries;
    return;
  }
  self.postMessage({ id: request.id, matches: searchFilenames(entries, request.query) });
};
