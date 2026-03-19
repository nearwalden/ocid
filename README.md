# ocid — OpenClaw Runtime Identity Store

A lightweight OpenClaw plugin that tracks session and sender identity data across all gateway lifecycle events. Designed as the foundation layer for policy enforcement: by the time a `before_tool_call` check needs to know *who* is asking, the identity is already in memory.

## What it does

When the gateway starts, `ocid` initializes an in-memory store and registers hooks across the full session lifecycle. As events flow through the gateway, the store builds up a picture of each session:

- **Who** originated it (sender's channel-scoped ID — Slack user ID, phone number, Telegram ID, CLI user)
- **Where** it came from (channel: `telegram`, `slack`, `discord`, `whatsapp`, etc.)
- **Why** it was triggered (`user`, `heartbeat`, `cron`, `memory`)
- **What** it has done (tool call log with timestamps)

No data is written to disk. The store lives for the gateway lifetime and is cleared on shutdown.

## Data captured

Every session produces a `SessionRecord` built up incrementally as hooks fire:

| Field | Source hook | Description |
|---|---|---|
| `sessionId` | `session_start` | Stable session identifier |
| `sessionKey` | `session_start` | Routing key (often encodes channel+conversation) |
| `resumedFrom` | `session_start` | Previous session ID if this is a resumption |
| `agentId` | `before_agent_start` | Which agent is running |
| `channelId` | `before_agent_start` | Channel name: `"telegram"`, `"slack"`, etc. |
| `trigger` | `before_agent_start` | What started the run: `"user"`, `"cron"`, `"heartbeat"`, `"memory"` |
| `messageProvider` | `before_agent_start` | LLM provider in use |
| `senderId` | `message_received` | Sender's channel-scoped ID (first observed value) |
| `accountId` | `message_received` | Account ID for multi-account channels |
| `conversationId` | `message_received` | Conversation/thread identifier |
| `toolCalls` | `before_tool_call` | Ordered log of every tool call with timestamp |
| `endedAt` / `durationMs` | `session_end` | Populated when the session finishes; record is kept |

## Indexes

The store maintains two indexes:

- **Primary** — `sessionKey → SessionRecord`: the main lookup path used at policy-check time
- **Secondary** — `channelId:senderId → Set<sessionKey>`: find all sessions for a given sender

## API

```typescript
import { getIdentityStore } from "@ocid/ocid";

// Get a single session
const session = getIdentityStore()?.getSession(sessionKey);

// All active + ended sessions
const all = getIdentityStore()?.allSessions();

// All sessions for a channel
const telegramSessions = getIdentityStore()?.sessionsByChannel("telegram");

// All sessions for a specific sender
const sender = getIdentityStore()?.getSender("slack", "U123ABC");
// → { senderId, channelId, sessionKeys: [...] }
```

`getIdentityStore()` returns `null` if the plugin hasn't started (gateway not running, plugin disabled, or in tests).

## Startup sequence

The store is initialized inside `registerService()`, which OpenClaw awaits before opening the gateway to traffic. Hooks fire in this order:

```
registerService.start()   ← store created, gateway not yet serving
        ↓
gateway_start             ← log confirmation
        ↓
session_start             ← per session: skeleton record created
        ↓
before_agent_start        ← per run: channel/trigger info added
        ↓
message_received          ← per inbound message: sender identity added
        ↓
before_tool_call          ← per tool: appended to toolCalls log
        ↓
session_end               ← end timestamp stamped; record kept
        ↓
registerService.stop()    ← store cleared on gateway shutdown
```

## Correlating messages to sessions

`message_received` carries no `sessionKey` — only `channelId`, `accountId`, and `conversationId`. The store correlates inbound messages to sessions by:

1. Matching `conversationId` exactly (preferred)
2. Falling back to the most recently active session on that `channelId` + `accountId`

This works well for the common single-conversation case. Multi-conversation edge cases may need tighter linking in a future version.

## Intended use

`ocid` is a building block. It does not enforce any policy itself. The intended consumer is a policy plugin that imports `getIdentityStore()` and uses the session record to resolve attributes before making allow/deny decisions on tool calls.

```typescript
// In a policy plugin's before_tool_call handler:
const session = getIdentityStore()?.getSession(ctx.sessionKey);
const channelId = session?.channelId;   // "slack"
const senderId  = session?.senderId;    // "U123ABC"
// → resolve attributes → evaluate policy → return { block: true } or nothing
```
