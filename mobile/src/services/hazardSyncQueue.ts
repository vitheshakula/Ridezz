import type { HazardEventPacket } from '../types/telemetry';

/** Hazards older than this are dropped outright -- a 45-minute-old pothole report is no longer
 * useful to anyone, online or off. Pruned lazily (see prune()), not on a timer: nothing needs to
 * happen the instant a hazard expires, only before it is next read or flushed. */
export const HAZARD_TTL_MS = 45 * 60 * 1000;

/** How far apart delivered hazards are spaced when catching a reconnected peer up, so a rider who
 * was out of range for an hour doesn't get five banners and five readouts at once. Each call to
 * popNextForPeer() is meant to be made this far apart by the caller (bleMeshManager's duty cycle,
 * or a dedicated timer) -- this module only tracks what's left to send, not time. */
export const RECONNECT_FLUSH_SPACING_MS = 8_000;

/**
 * Pending hazards for riders who may be out of BLE range, plus which known peers have already
 * received which hazard -- so a peer who drops off and comes back gets exactly what they missed,
 * not everything again, and not all of it in one burst.
 *
 * This is in-memory only: a hazard mesh is inherently short-lived local context (a specific ride,
 * specific riders nearby right now), not something worth persisting across app restarts the way a
 * saved profile or room code is.
 */
export class HazardSyncQueue {
  /** Newest first (a LIFO stack): the most recent hazard matters most, and popNextForPeer below
   * deliberately walks it oldest-first instead to read as "catch up in the order things happened". */
  private readonly hazards: HazardEventPacket[] = [];
  private readonly receivedBy = new Map<string, Set<string>>(); // hazardId -> peer ids
  private readonly knownToSelf = new Set<string>(); // hazardId

  constructor(private readonly now: () => number = Date.now) {}

  /** Removes anything older than HAZARD_TTL_MS. Called at the start of every other method, so a
   * caller never has to remember to schedule it separately. */
  private prune(): void {
    const cutoff = this.now() - HAZARD_TTL_MS;
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      if (this.hazards[i].timestamp < cutoff) {
        this.receivedBy.delete(this.hazards[i].hazardId);
        this.hazards.splice(i, 1);
      }
    }
  }

  /** True if this hazard has already been recorded (by id), regardless of whether it has since
   * expired -- the mesh manager's duplicate-suppression check needs this to stay true for an id
   * even after the packet itself is pruned, so an old copy still circulating after TTL isn't
   * re-admitted and re-relayed. */
  hasSeen(hazardId: string): boolean {
    return this.knownToSelf.has(hazardId);
  }

  /**
   * Records a hazard as known to this device, including one this device itself just raised. A
   * hazard already seen (by id) is left exactly as it was -- re-adding it does not refresh its
   * timestamp or move it in the stack, since that would let a looping duplicate outlive its real
   * TTL. Returns false (and does nothing else) for a hazard already expired on arrival.
   */
  add(hazard: HazardEventPacket): boolean {
    this.prune();
    if (this.knownToSelf.has(hazard.hazardId)) {
      return false;
    }
    if (this.now() - hazard.timestamp > HAZARD_TTL_MS) {
      return false;
    }
    this.knownToSelf.add(hazard.hazardId);
    this.hazards.push(hazard);
    return true;
  }

  /** Every currently unexpired hazard, newest first. */
  active(): HazardEventPacket[] {
    this.prune();
    return [...this.hazards].sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Marks that `peerId` is now known to have `hazardId` (it reported it, relayed it, or this
   * device already flushed it to them) -- popNextForPeer will not offer it again. */
  markReceivedBy(hazardId: string, peerId: string): void {
    const peers = this.receivedBy.get(hazardId);
    if (peers) {
      peers.add(peerId);
    } else {
      this.receivedBy.set(hazardId, new Set([peerId]));
    }
  }

  /** True once `peerId` has been marked as having `hazardId`. */
  hasReceivedBy(hazardId: string, peerId: string): boolean {
    return this.receivedBy.get(hazardId)?.has(peerId) ?? false;
  }

  /**
   * The next hazard `peerId` is missing, oldest first (so a rider catching up sees events unfold
   * in the order they happened, not newest-first). Marks it as sent to that peer as a side effect,
   * so repeated calls walk forward through the backlog -- callers (see RECONNECT_FLUSH_SPACING_MS)
   * are expected to call this once per spacing interval, not all at once. Returns null once the
   * peer is fully caught up, or when there is nothing pending at all.
   */
  popNextForPeer(peerId: string): HazardEventPacket | null {
    this.prune();
    const pending = [...this.hazards]
      .sort((a, b) => a.timestamp - b.timestamp)
      .find(hazard => !this.hasReceivedBy(hazard.hazardId, peerId));
    if (!pending) {
      return null;
    }
    this.markReceivedBy(pending.hazardId, peerId);
    return pending;
  }

  /** How many hazards `peerId` is still missing -- lets a caller decide whether it's worth
   * starting a flush at all, or show "catching up: 3 hazards" in the UI. */
  pendingCountForPeer(peerId: string): number {
    this.prune();
    return this.hazards.filter(hazard => !this.hasReceivedBy(hazard.hazardId, peerId)).length;
  }

  /** Forgets a peer's receipt record entirely, so the next popNextForPeer calls replay everything
   * still active -- for when a peer's own identity resets (a fresh app install, say) and the old
   * record would otherwise wrongly skip hazards they've genuinely never seen. */
  forgetPeer(peerId: string): void {
    for (const peers of this.receivedBy.values()) {
      peers.delete(peerId);
    }
  }
}
