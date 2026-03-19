// ============================================================================
// Runtime identity store types
// ============================================================================

/** A single tool call observed within a session. */
export type ToolCallRecord = {
  toolName: string;
  runId?: string;
  toolCallId?: string;
  at: number; // Date.now()
};

/**
 * Everything we know about a session, built up incrementally as hooks fire.
 *
 * Fields are optional because different hooks fire at different times and
 * not all sessions go through every hook (e.g. autonomous cron sessions
 * never receive a message_received event).
 */
export type SessionRecord = {
  // --- from session_start ---
  sessionId: string;
  sessionKey?: string;
  resumedFrom?: string;
  startedAt: number;

  // --- from before_agent_start (ctx) ---
  agentId?: string;
  /** Channel that originated this session: "telegram", "slack", "discord", etc. */
  channelId?: string;
  /** What triggered the run: "user", "heartbeat", "cron", "memory". */
  trigger?: string;
  /** LLM provider used: "openai", "anthropic", etc. */
  messageProvider?: string;
  workspaceDir?: string;

  // --- from message_received ---
  /**
   * The sender's channel-scoped identifier (e.g. Telegram user ID, Slack user ID,
   * phone number). May be set multiple times if the session processes multiple
   * inbound messages; we keep the first observed value.
   */
  senderId?: string;
  /** accountId from the message context — useful for multi-account channels. */
  accountId?: string;
  /** conversationId from the message context. */
  conversationId?: string;

  // --- running state ---
  lastActiveAt: number;
  messageCount: number;
  toolCalls: ToolCallRecord[];

  // --- from session_end ---
  endedAt?: number;
  durationMs?: number;
};

/**
 * A snapshot of everything the store knows about a session.
 * Returned from lookups; callers should not mutate the record directly.
 */
export type SessionSnapshot = Readonly<SessionRecord>;

/**
 * Summary of what the store knows about a specific sender identity
 * across all sessions it has been seen in.
 */
export type SenderSummary = {
  senderId: string;
  channelId: string;
  sessionKeys: string[];
};
