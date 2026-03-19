# System Architecture

## Boot sequence

1. **Gateway boots** — the identity service initializes and loads all identity data and attributes into memory.
2. **Policy service loads** — reads the current policy into memory.
3. Gateway begins accepting traffic.

## Request flow

When a request arrives, the policy service evaluates it against the loaded identity attributes and policy rules. On approval, it issues a **visa** — a time-bounded approval record for that identity/action combination. Visas are kept in an in-memory table for O(1) lookup on subsequent requests, so repeated calls from the same identity skip the full policy evaluation path.

## Visa lifecycle

- **Issued** at first approval; carries an expiry timestamp and the scope of what was approved.
- **Checked** on every subsequent request: if a valid visa exists, the request is fast-pathed through.
- **Expired** visas are treated as absent; a fresh policy check runs and a new visa is issued if still approved.
- **Revoked** explicitly by the user at any time (see below).

## Policy and visa invalidation

Users can revoke visas or change policy at runtime. Either action triggers targeted invalidation:

- **Visa revocation** — removes the specific visa record(s) for the named identity or scope. Subsequent requests from that identity run a fresh policy check.
- **Policy change** — all visas whose approval was derived from the changed rule are nuked. Affected identities get a fresh policy check on their next request; identities not covered by the changed rule keep their visas.

No gateway restart is required. Changes take effect immediately on the next affected request.
