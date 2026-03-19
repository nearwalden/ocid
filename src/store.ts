import type { SenderSummary, SessionRecord, SessionSnapshot, ToolCallRecord } from "./types.js";

// ============================================================================
// IdentityStore
//
// All session and sender identity data for the current gateway lifetime.
// Keyed by sessionKey (primary) with a secondary index on channelId+senderId.
// No persistence — everything lives in memory and is gone when the gateway stops.
// ============================================================================

export class IdentityStore {
  // Primary index: sessionKey → record
  private readonly sessions = new Map<string, SessionRecord>();

  // Secondary index: "<channelId>:<senderId>" → Set<sessionKey>
  // Lets us quickly find all sessions for a given sender.
  private readonly senderIndex = new Map<string, Set<string>>();

  // ── Session lifecycle ──────────────────────────────────────────────────────

  /** Called from session_start. Creates the skeleton record. */
  onSessionStart(params: {
    sessionId: string;
    sessionKey?: string;
    resumedFrom?: string;
  }): void {
    const key = params.sessionKey ?? params.sessionId;
    const existing = this.sessions.get(key);
    if (existing) {
      // Resumed session — update resumedFrom and reset lastActiveAt.
      existing.resumedFrom = params.resumedFrom ?? existing.resumedFrom;
      existing.lastActiveAt = Date.now();
      return;
    }
    const record: SessionRecord = {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      resumedFrom: params.resumedFrom,
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      messageCount: 0,
      toolCalls: [],
    };
    this.sessions.set(key, record);
  }

  /**
   * Called from before_agent_start context. Enriches with channel/trigger info.
   * Safe to call multiple times — existing values are not overwritten.
   */
  onAgentContext(params: {
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
    channelId?: string;
    trigger?: string;
    messageProvider?: string;
    workspaceDir?: string;
  }): void {
    const record = this.resolveRecord(params.sessionKey, params.sessionId);
    if (!record) return;

    record.agentId ??= params.agentId;
    record.channelId ??= params.channelId;
    record.trigger ??= params.trigger;
    record.messageProvider ??= params.messageProvider;
    record.workspaceDir ??= params.workspaceDir;
    record.lastActiveAt = Date.now();
  }

  /**
   * Called from message_received context. Enriches with sender identity.
   * We record the sender on the most-recently-active session for the channel+account
   * combination, since message_received doesn't carry a sessionKey.
   */
  onMessageReceived(params: {
    from: string;
    channelId: string;
    accountId?: string;
    conversationId?: string;
  }): void {
    // Find the best matching session: same channel, same conversationId if available,
    // else the most recently active session on this channel.
    const record = this.findSessionForMessage(params);
    if (!record) return;

    // Only set senderId on first observation — keeps the "original caller" identity stable.
    if (!record.senderId) {
      record.senderId = params.from;
      // Index this sender so we can look up all their sessions later.
      this.indexSender(record.channelId ?? params.channelId, params.from, this.keyFor(record));
    }
    record.accountId ??= params.accountId;
    record.conversationId ??= params.conversationId;
    record.messageCount += 1;
    record.lastActiveAt = Date.now();
  }

  /** Called from before_tool_call context. Appends to the tool call log. */
  onToolCall(params: {
    sessionKey?: string;
    sessionId?: string;
    toolName: string;
    runId?: string;
    toolCallId?: string;
  }): void {
    const record = this.resolveRecord(params.sessionKey, params.sessionId);
    if (!record) return;

    const entry: ToolCallRecord = {
      toolName: params.toolName,
      runId: params.runId,
      toolCallId: params.toolCallId,
      at: Date.now(),
    };
    record.toolCalls.push(entry);
    record.lastActiveAt = Date.now();
  }

  /** Called from session_end. Stamps end time; record is kept for the gateway lifetime. */
  onSessionEnd(params: {
    sessionKey?: string;
    sessionId?: string;
    durationMs?: number;
  }): void {
    const record = this.resolveRecord(params.sessionKey, params.sessionId);
    if (!record) return;
    record.endedAt = Date.now();
    record.durationMs = params.durationMs;
  }

  // ── Lookups ────────────────────────────────────────────────────────────────

  /** Returns a read-only snapshot of a session, or undefined if unknown. */
  getSession(sessionKey: string): SessionSnapshot | undefined {
    return this.sessions.get(sessionKey) as SessionSnapshot | undefined;
  }

  /** Returns all session keys currently in the store. */
  allSessionKeys(): string[] {
    return [...this.sessions.keys()];
  }

  /** Returns all sessions as snapshots. */
  allSessions(): SessionSnapshot[] {
    return [...this.sessions.values()] as SessionSnapshot[];
  }

  /** Returns all sessions for a given channelId. */
  sessionsByChannel(channelId: string): SessionSnapshot[] {
    return this.allSessions().filter((s) => s.channelId === channelId);
  }

  /**
   * Returns a summary of all sessions seen for a given sender.
   * Returns undefined if the sender has never been observed.
   */
  getSender(channelId: string, senderId: string): SenderSummary | undefined {
    const indexKey = `${channelId}:${senderId}`;
    const keys = this.senderIndex.get(indexKey);
    if (!keys || keys.size === 0) return undefined;
    return { senderId, channelId, sessionKeys: [...keys] };
  }

  /** Total number of sessions in the store (active + ended). */
  get size(): number {
    return this.sessions.size;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private keyFor(record: SessionRecord): string {
    return record.sessionKey ?? record.sessionId;
  }

  private resolveRecord(sessionKey?: string, sessionId?: string): SessionRecord | undefined {
    if (sessionKey) return this.sessions.get(sessionKey);
    if (sessionId) {
      // Fallback: linear scan for sessionId match (uncommon path)
      for (const record of this.sessions.values()) {
        if (record.sessionId === sessionId) return record;
      }
    }
    return undefined;
  }

  private findSessionForMessage(params: {
    channelId: string;
    accountId?: string;
    conversationId?: string;
  }): SessionRecord | undefined {
    // Prefer exact conversationId match.
    if (params.conversationId) {
      for (const record of this.sessions.values()) {
        if (
          record.channelId === params.channelId &&
          record.conversationId === params.conversationId
        ) {
          return record;
        }
      }
    }

    // Fall back to the most recently active session on this channel+account.
    let best: SessionRecord | undefined;
    for (const record of this.sessions.values()) {
      if (record.channelId !== params.channelId) continue;
      if (params.accountId && record.accountId && record.accountId !== params.accountId) continue;
      if (!best || record.lastActiveAt > best.lastActiveAt) {
        best = record;
      }
    }
    return best;
  }

  private indexSender(channelId: string, senderId: string, sessionKey: string): void {
    const indexKey = `${channelId}:${senderId}`;
    let set = this.senderIndex.get(indexKey);
    if (!set) {
      set = new Set();
      this.senderIndex.set(indexKey, set);
    }
    set.add(sessionKey);
  }
}
