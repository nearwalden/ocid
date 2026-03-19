import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createIdentityService } from "./src/service.js";

export { getIdentityStore, getVisaService } from "./src/service.js";
export { DEFAULT_VISA_TTL_MS } from "./src/visa.js";
export type {
  SessionRecord,
  SessionSnapshot,
  SenderSummary,
  ToolCallRecord,
  Visa,
  VisaCheckResult,
} from "./src/types.js";

const plugin = {
  id: "ocid",
  name: "OC Identity",
  description:
    "Runtime identity store and visa service — tracks sessions, channels, and senders for policy enforcement",
  register(api: OpenClawPluginApi) {
    createIdentityService(api);

    // ── Command: /ocid-revoke-all ──────────────────────────────────────────
    // Revokes every visa in the store. Use when policy changes wholesale or
    // an operator wants a clean start without restarting the gateway.
    api.registerCommand({
      name: "ocid-revoke-all",
      description: "Revoke all active visas (forces fresh policy checks on next tool call)",
      async run(ctx) {
        const { getVisaService } = await import("./src/service.js");
        const visas = getVisaService();
        if (!visas) {
          ctx.reply("ocid visa service is not running.");
          return;
        }
        const before = visas.size;
        visas.revokeAll();
        ctx.reply(`Revoked ${before} visa(s). All sessions will re-evaluate policy on next tool call.`);
      },
    });
  },
};

export default plugin;
