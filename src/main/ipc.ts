import { ipcMain, type IpcMainInvokeEvent } from "electron";

export type IpcSenderValidator = (event: IpcMainInvokeEvent) => boolean;

/**
 * Registers an invoke handler that is only reachable from the app's top-level renderer frame.
 * Every renderer-to-main capability crosses this guard before it reaches a domain handler.
 */
export function handleTrustedIpc(
  channel: string,
  isTrustedSender: IpcSenderValidator,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedSender(event)) throw new Error("Rejected IPC from an untrusted renderer");
    return handler(event, ...args);
  });
}
