import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createIdentityService } from "./src/service.js";

export { getIdentityStore } from "./src/service.js";
export type { SessionRecord, SessionSnapshot, SenderSummary, ToolCallRecord } from "./src/types.js";

const plugin = {
  id: "ocid",
  name: "OC Identity",
  description:
    "Runtime identity store — tracks sessions, channels, and senders for policy enforcement",
  register(api: OpenClawPluginApi) {
    createIdentityService(api);
  },
};

export default plugin;
