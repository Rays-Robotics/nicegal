import type { NicegalBridge } from "../shared/backend";

declare global {
  interface Window {
    nicegal: NicegalBridge;
  }
}
