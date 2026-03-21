import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { IdentityStore, UserInfoStore } from "./store.js";
import { VisaService } from "./visa.js";

// Module-level singletons — shared across the plugin's register() call and
// any future consumers that import getIdentityStore() / getVisaService().
let activeStore: IdentityStore | null = null;
let activeVisas: VisaService | null = null;
let activeUserInfo: UserInfoStore | null = null;

/**
 * Returns the active identity store for this gateway lifetime.
 * Returns null if the service hasn't started yet (e.g. during tests or
 * if the plugin is disabled).
 */
export function getIdentityStore(): IdentityStore | null {
  return activeStore;
}

/**
 * Returns the active visa service for this gateway lifetime.
 * Returns null if the service hasn't started yet.
 */
export function getVisaService(): VisaService | null {
  return activeVisas;
}

/**
 * Returns the active user info store for this gateway lifetime.
 * Returns null if the service hasn't started yet.
 */
export function getUserInfoStore(): UserInfoStore | null {
  return activeUserInfo;
}

/**
 * Wires up all lifecycle hooks and returns a service object for registerService().
 * Hooks are registered immediately in register(); the service start/stop only
 * manages the store/visa singleton lifetimes.
 */
export function createIdentityService(api: OpenClawPluginApi): void {
  // ── Service: owns the store and visa lifetime ──────────────────────────────
  // Registered first so both are ready before gateway_start fires.
  api.registerService({
    id: "ocid",
    async start(ctx) {
      activeStore = new IdentityStore();
      activeVisas = new VisaService();
      activeUserInfo = new UserInfoStore();
      ctx.logger.info("[ocid] identity store, visa service, and user info store initialized");
    },
    async stop(ctx) {
      const sessions = activeStore?.size ?? 0;
      const visas = activeVisas?.size ?? 0;
      const users = activeUserInfo?.size ?? 0;
      activeStore = null;
      activeVisas = null;
      activeUserInfo = null;
      ctx.logger.info(`[ocid] cleared (${sessions} sessions, ${visas} visas, ${users} users)`);
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
  // Visa checking happens in a policy plugin that imports getVisaService();
  // this hook is observe-only here.
  api.on("before_tool_call", (event, ctx) => {
    activeStore?.onToolCall({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      toolName: event.toolName,
      runId: event.runId ?? ctx.runId,
      toolCallId: event.toolCallId ?? ctx.toolCallId,
    });
  });

  // ── Hook: session_end ──────────────────────────────────────────────────────
  // Fires when a session finishes. Stamps the end time on the identity record
  // and revokes all visas for the session — they're no longer needed.
  api.on("session_end", (event, ctx) => {
    const sessionId = event.sessionId ?? ctx.sessionId;

    activeStore?.onSessionEnd({
      sessionKey: event.sessionKey ?? ctx.sessionKey,
      sessionId,
      durationMs: event.durationMs,
    });

    if (sessionId) {
      const revoked = activeVisas?.revokeSession(sessionId) ?? 0;
      if (revoked > 0) {
        api.logger.debug(`[ocid] revoked ${revoked} visa(s) for ended session ${sessionId}`);
      }
    }
  });

  // ── Hook: gateway_start ────────────────────────────────────────────────────
  // Log confirmation once the gateway is open for traffic.
  api.on("gateway_start", ({ port }) => {
    api.logger.info(`[ocid] gateway up on port ${port}, identity store and visa service ready`);
  });
}
