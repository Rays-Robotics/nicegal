import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Main reads this before scheduling network work; renderer localStorage would arrive too late. */
export function loadAutomaticUpdates(path: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("automaticUpdates" in value) ||
      typeof value.automaticUpdates !== "boolean"
    ) {
      throw new Error("Invalid automatic update preference");
    }
    return value.automaticUpdates;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    // Do not silently opt someone back in when their saved preference cannot be read.
    console.error("Could not read update preferences; automatic updates are disabled", error);
    return false;
  }
}

export function saveAutomaticUpdates(path: string, enabled: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ automaticUpdates: enabled })}\n`, {
    mode: 0o600,
  });
  renameSync(`${path}.tmp`, path);
}
