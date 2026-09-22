export function errorMessage(error: unknown): string {
  const message = cleanDiagnostic(error instanceof Error ? error.message : String(error));
  const prefix = /^Error invoking remote method '[^']*':\s*/;

  if (!prefix.test(message)) return message;
  return message.replace(prefix, "").replace(/^Error:\s*/, "");
}

/** Terminal formatting is never useful in UI text or copied diagnostic reports. */
export function cleanDiagnostic(message: string): string {
  /* eslint-disable no-control-regex -- intentionally remove terminal control sequences */
  return (
    message
      // OSC (including hyperlink titles), CSI colour/cursor sequences, and stray controls.
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .trim()
  );
  /* eslint-enable no-control-regex */
}

export function searchErrorMessage(error: unknown): string {
  return errorMessage(error);
}

/**
 * Whether a message is the backend rejecting a query's syntax rather than failing to run it —
 * the one search error the user can fix by retyping, so it's the one worth attaching syntax help
 * to. Matches the prefix `main/backend/nicegal-server-client.ts` puts on an FTS5 `query_syntax` code.
 */
export function isQuerySyntaxError(message: string): boolean {
  return message.startsWith("Query syntax —");
}
