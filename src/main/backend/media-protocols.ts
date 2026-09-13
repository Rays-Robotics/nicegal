import { net, protocol } from "electron";
import { pathToFileURL } from "node:url";

import type { NicegalServerClient } from "./nicegal-server-client";
import type { ThumbnailReader } from "./thumbnail-reader";

export function registerMediaSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "thumb",
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
    {
      scheme: "original",
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

/** Install once before creating the window; reader getters also cover backend restarts. */
export function installMediaProtocolHandlers(
  catalog: () => NicegalServerClient | null,
  thumbnails: () => ThumbnailReader | null,
): void {
  protocol.handle("thumb", (request) => {
    try {
      const url = new URL(request.url);
      const assetId = url.pathname.slice(1);
      const size = Number(url.searchParams.get("size"));
      const generatorVersion = Number(url.searchParams.get("v"));
      const modifiedNs = url.searchParams.get("mtime") ?? "";
      const sourceSize = url.searchParams.get("bytes") ?? "";
      if (
        url.hostname !== "asset" ||
        !/^\d+$/.test(assetId) ||
        !Number.isInteger(size) ||
        size < 1 ||
        size > 1024 ||
        !Number.isInteger(generatorVersion) ||
        generatorVersion < 1 ||
        !/^-?\d+$/.test(modifiedNs) ||
        !/^\d+$/.test(sourceSize)
      ) {
        return new Response("Invalid thumbnail URL", { status: 400 });
      }

      const reader = thumbnails();
      if (!reader) return new Response("Thumbnail service is starting", { status: 503 });
      const thumbnail = reader.get(assetId, generatorVersion, modifiedNs, sourceSize, size);
      if (!thumbnail) return new Response("Thumbnail not found", { status: 404 });
      return new Response(thumbnail.data as unknown as BodyInit, {
        status: 200,
        headers: {
          "content-type": thumbnail.encoding,
          // A stale hit (source changed, fresh variant not backfilled yet) must stay cheaply
          // re-checkable: the URL's mtime/bytes already match the *current* source fingerprint, so
          // once a backfill generates the real variant at that same URL, a long/immutable cache
          // would otherwise keep serving the stale bytes indefinitely.
          "cache-control": thumbnail.stale
            ? "private, max-age=30, must-revalidate"
            : "private, max-age=31536000, immutable",
          "x-thumbnail-size-bucket": String(thumbnail.sizeBucket),
          "x-thumbnail-width": String(thumbnail.width),
          "x-thumbnail-height": String(thumbnail.height),
          "x-thumbnail-stale": thumbnail.stale ? "1" : "0",
        },
      });
    } catch (error) {
      console.error("Thumbnail protocol request failed", error);
      return new Response("Thumbnail request failed", { status: 500 });
    }
  });

  protocol.handle("original", async (request) => {
    try {
      const url = new URL(request.url);
      const assetId = url.pathname.slice(1);
      const modifiedNs = url.searchParams.get("mtime") ?? "";
      const sourceSize = url.searchParams.get("bytes") ?? "";
      if (
        url.hostname !== "asset" ||
        !/^\d+$/.test(assetId) ||
        !/^-?\d+$/.test(modifiedNs) ||
        !/^\d+$/.test(sourceSize)
      ) {
        return new Response("Invalid original-media URL", { status: 400 });
      }
      const reader = catalog();
      if (!reader) return new Response("Catalog service is starting", { status: 503 });
      const asset = (await reader.resolveAssets([assetId])).assets[0];
      if (!asset || asset.modifiedNs !== modifiedNs || String(asset.sourceSize) !== sourceSize) {
        return new Response("Original media not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(asset.path).toString());
    } catch (error) {
      console.error("Original-media protocol request failed", error);
      return new Response("Original-media request failed", { status: 500 });
    }
  });
}
