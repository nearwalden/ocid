import type { Visa, VisaCheckResult } from "./types.js";

// ============================================================================
// VisaService
//
// In-memory store of time-bounded approvals keyed by sessionId:toolName.
//
// Intended usage by a policy plugin:
//   1. before_tool_call fires → call check(sessionId, toolName)
//   2. If valid → fast-path allow
//   3. If absent/expired → run full policy evaluation
//   4. Policy approves → call issue(sessionId, toolName) → allow
//   5. Policy denies  → block the call (do not issue a visa)
//
// On session_end the service automatically revokes all visas for that session
// (wired in service.ts). Visas can also be revoked explicitly at any time —
// e.g. when policy changes or an operator calls revokeSession().
// ============================================================================

/** Default visa lifetime: 30 minutes. */
export const DEFAULT_VISA_TTL_MS = 30 * 60 * 1000;

export class VisaService {
  // Primary map: "sessionId:toolName" → Visa
  private readonly visas = new Map<string, Visa>();

  // Secondary index: sessionId → Set of primary keys for that session.
  // Lets revokeSession() avoid a full scan.
  private readonly sessionIndex = new Map<string, Set<string>>();

  // ── Compose / decompose key ────────────────────────────────────────────────

  private key(sessionId: string, toolName: string): string {
    return `${sessionId}:${toolName}`;
  }

  // ── Core operations ────────────────────────────────────────────────────────

  /**
   * Issue (or renew) a visa for the given session+tool pair.
   * If a visa already exists it is overwritten with a fresh expiry.
   *
   * @param ttlMs  How long the visa is valid for. Defaults to DEFAULT_VISA_TTL_MS.
   */
  issue(sessionId: string, toolName: string, ttlMs = DEFAULT_VISA_TTL_MS, runId?: string): Visa {
    const now = Date.now();
    const visa: Visa = {
      sessionId,
      toolName,
      issuedAt: now,
      expiresAt: now + ttlMs,
      runId,
    };
    const k = this.key(sessionId, toolName);
    this.visas.set(k, visa);
    this.indexSession(sessionId, k);
    return visa;
  }

  /**
   * Check whether a valid (non-expired) visa exists for this session+tool pair.
   * Expired visas are pruned from the store on the way out.
   */
  check(sessionId: string, toolName: string): VisaCheckResult {
    const k = this.key(sessionId, toolName);
    const visa = this.visas.get(k);
    if (!visa) {
      return { valid: false, reason: "absent" };
    }
    if (Date.now() > visa.expiresAt) {
      // Prune the expired entry.
      this.visas.delete(k);
      this.sessionIndex.get(sessionId)?.delete(k);
      return { valid: false, reason: "expired" };
    }
    return { valid: true, visa };
  }

  /**
   * Revoke a single visa. Returns true if a visa existed and was removed.
   */
  revoke(sessionId: string, toolName: string): boolean {
    const k = this.key(sessionId, toolName);
    const existed = this.visas.delete(k);
    if (existed) {
      this.sessionIndex.get(sessionId)?.delete(k);
    }
    return existed;
  }

  /**
   * Revoke all visas for a session.
   * Called automatically on session_end; also useful for operator-driven revocation.
   *
   * @returns The number of visas revoked.
   */
  revokeSession(sessionId: string): number {
    const keys = this.sessionIndex.get(sessionId);
    if (!keys || keys.size === 0) return 0;
    let count = 0;
    for (const k of keys) {
      if (this.visas.delete(k)) count++;
    }
    this.sessionIndex.delete(sessionId);
    return count;
  }

  /**
   * Revoke all visas across all sessions.
   * Called on gateway shutdown or a global policy change.
   */
  revokeAll(): void {
    this.visas.clear();
    this.sessionIndex.clear();
  }

  // ── Introspection ──────────────────────────────────────────────────────────

  /** Total number of visas currently in the store (including any expired but un-checked). */
  get size(): number {
    return this.visas.size;
  }

  /** Returns all currently stored visas (may include expired ones not yet pruned). */
  allVisas(): Visa[] {
    return [...this.visas.values()];
  }

  /** Returns all visas for a given session (may include expired ones not yet pruned). */
  visasForSession(sessionId: string): Visa[] {
    const keys = this.sessionIndex.get(sessionId);
    if (!keys) return [];
    const result: Visa[] = [];
    for (const k of keys) {
      const v = this.visas.get(k);
      if (v) result.push(v);
    }
    return result;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private indexSession(sessionId: string, key: string): void {
    let set = this.sessionIndex.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionIndex.set(sessionId, set);
    }
    set.add(key);
  }
}
