import type { ExternalVisualReference } from "../../../shared/backend";
import type { OcrSearchController } from "./ocr-search.svelte";

import { visualFileBase64 } from "./visual-file";

/** Image imports belong to the visual-search session that requested them.
 * Clearing or changing scope while a picker/read is pending discards the late result. */
export async function addDroppedVisualFiles(
  ocrSearch: OcrSearchController,
  files: File[],
): Promise<void> {
  const session = ocrSearch.visualSessionRevision;
  const limit = 16 * 1024 * 1024;
  const accepted: ExternalVisualReference[] = [];
  for (const file of files.slice(0, 16)) {
    if (file.size > limit) {
      ocrSearch.error = `${file.name} is larger than the 16 MB visual-search limit.`;
      continue;
    }
    let bytesBase64: string;
    try {
      bytesBase64 = await visualFileBase64(file);
    } catch (error: unknown) {
      if (session === ocrSearch.visualSessionRevision) {
        ocrSearch.error = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    if (session !== ocrSearch.visualSessionRevision) return;
    accepted.push({ displayName: file.name, bytesBase64 });
  }
  if (accepted.length && session === ocrSearch.visualSessionRevision)
    ocrSearch.addExternalReferences(accepted);
}

export async function chooseVisualFile(ocrSearch: OcrSearchController): Promise<void> {
  const session = ocrSearch.visualSessionRevision;
  try {
    const reference = await window.nicegal.native.chooseVisualSearchImage();
    if (reference && session === ocrSearch.visualSessionRevision) {
      ocrSearch.addExternalReferences([reference]);
    }
  } catch (error: unknown) {
    if (session === ocrSearch.visualSessionRevision) {
      ocrSearch.error = error instanceof Error ? error.message : String(error);
    }
  }
}
