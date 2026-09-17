import { searchFilenames, type FilenameEntry } from "./filename-search";

type NamedItem = { id: string; displayName: string };
type SearchReply = { id: number; matches: FilenameEntry[] };

/** One catalog copy per worker, refreshed only when the immutable catalog array is replaced. */
export class FilenameSearchClient {
  private worker: Worker | undefined;
  private catalog: readonly NamedItem[] | undefined;
  private entries: FilenameEntry[] = [];
  private requestId = 0;
  private pending = new Map<
    number,
    { query: string; resolve: (matches: FilenameEntry[]) => void }
  >();
  private failed = false;

  search(items: readonly NamedItem[], query: string): Promise<FilenameEntry[]> {
    if (items !== this.catalog) {
      this.catalog = items;
      this.entries = items.map((item) => [item.id, item.displayName]);
      this.ensureWorker()?.postMessage({ kind: "catalog", entries: this.entries });
    }
    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve(searchFilenames(this.entries, query));
    const id = ++this.requestId;
    return new Promise((resolve) => {
      this.pending.set(id, { query, resolve });
      worker.postMessage({ kind: "search", id, query });
    });
  }

  private ensureWorker(): Worker | undefined {
    if (this.worker || this.failed || typeof Worker === "undefined") return this.worker;
    try {
      const worker = new Worker(new URL("./filename-search.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<SearchReply>): void => {
        const resolve = this.pending.get(event.data.id);
        this.pending.delete(event.data.id);
        resolve?.resolve(event.data.matches);
      };
      worker.onerror = (): void => {
        worker.terminate();
        this.worker = undefined;
        this.failed = true;
        for (const { query, resolve } of this.pending.values())
          resolve(searchFilenames(this.entries, query));
        this.pending.clear();
      };
      this.worker = worker;
    } catch (error) {
      console.warn("Filename search worker unavailable", error);
      this.failed = true;
    }
    return this.worker;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.pending.clear();
    this.catalog = undefined;
    this.entries = [];
  }
}
