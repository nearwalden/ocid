import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { IdentityStore } from "./store.js";

// Module-level singleton — shared across the plugin's register() call and
// any future consumers that import getIdentityStore().
let activeStore: IdentityStore | null = null;

/**
 * Returns the active identity store for this gateway lifetime.
 * Returns null if the service hasn't started yet (e.g. during tests or
 * if the plugin is disabled).
 */
export function getIdentityStore(): IdentityStore | null {
  return activeStore;
}

/**
 * Wires up all lifecycle hooks and returns a service object for registerService().
 * Hooks are registered immediately in register(); the service start/stop only
 * manages the store singleton lifetime.
 */
export function createIdentityService(api: OpenClawPluginApi): void {
  // ── Service: owns the store lifetime ──────────────────────────────────────
  // Registered first so the store is ready before gateway_start fires.
  api.registerService({
    id: "ocid",
    async start(ctx) {
      activeStore = new IdentityStore();
      ctx.logger.info("[ocid] identity store initialized");
    },
    async stop(ctx) {
      const count = activeStore?.size ?? 0;
      activeStore = null;
      ctx.logger.info(`[ocid] identity store cleared (${count} sessions)`);
    },
  });

  // ── Hook: session_start ────────────────────────────────────────────────────
  // Fires when a session is created or resumed. Creates the skeleton record.
  api.on("session_start", (event, ctx) => {
    activeStore?.onSessionStart({
      sessionId: event.sessionId,
      sessionKey: event.sessionKey ?? ctx.sessionKey,
      resumedFrom: event.resumedFrom,
    });
  });

  // ── Hook: before_agent_start ───────────────────────────────────────────────
  // Fires before each agent run within a session. Carries channel/trigger info
  // that isn't available at session_start time.
  api.on("before_agent_start", (_event, ctx) => {
    activeStore?.onAgentContext({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      channelId: ctx.channelId,
      trigger: ctx.trigger,
      messageProvider: ctx.messageProvider,
      workspaceDir: ctx.workspaceDir,
    });
  });

  // ── Hook: message_received ─────────────────────────────────────────────────
  // Fires when an inbound message arrives. Carries the sender's channel identity.
  // Note: this context has no sessionKey — the store correlates via conversationId
  // or falls back to the most-recently-active session on the channel.
  api.on("message_received", (event, ctx) => {
    activeStore?.onMessageReceived({
      from: event.from,
      channelId: ctx.channelId,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
    });
  });

  // ── Hook: before_tool_call ─────────────────────────────────────────────────
  // Fires before every tool call. Append to the session's tool call log.
  api.on("before_tool_call", (event, ctx) => {
    activeStore?.onToolCall({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      toolName: event.toolName,
      runId: event.runId ?? ctx.runId,
      toolCallId: event.toolCallId ?? ctx.toolCallId,
    });
    // Return nothing — this hook is observe-only; blocking happens elsewhere.
  });

  // ── Hook: session_end ──────────────────────────────────────────────────────
  // Fires when a session finishes. Stamps the end time; record is kept.
  api.on("session_end", (event, ctx) => {
    activeStore?.onSessionEnd({
      sessionKey: event.sessionKey ?? ctx.sessionKey,
      sessionId: event.sessionId,
      durationMs: event.durationMs,
    });
  });

  // ── Hook: gateway_start ────────────────────────────────────────────────────
  // Log what the registry looks like at startup — useful for debugging.
  api.on("gateway_start", ({ port }) => {
    api.logger.info(`[ocid] gateway up on port ${port}, identity store ready`);
  });
}
