import type { HazardEventPacket } from '../types/telemetry';

export const HAZARD_TTL_MS = 45 * 60 * 1000;

export const RECONNECT_FLUSH_SPACING_MS = 8_000;

export class HazardSyncQueue {
  private readonly hazards: HazardEventPacket[] = [];
  private readonly receivedBy = new Map<string, Set<string>>();
  private readonly knownToSelf = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    const cutoff = this.now() - HAZARD_TTL_MS;
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      if (this.hazards[i].timestamp < cutoff) {
        this.receivedBy.delete(this.hazards[i].hazardId);
        this.hazards.splice(i, 1);
      }
    }
  }

  hasSeen(hazardId: string): boolean {
    return this.knownToSelf.has(hazardId);
  }

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

  active(): HazardEventPacket[] {
    this.prune();
    return [...this.hazards].sort((a, b) => b.timestamp - a.timestamp);
  }

  markReceivedBy(hazardId: string, peerId: string): void {
    const peers = this.receivedBy.get(hazardId);
    if (peers) {
      peers.add(peerId);
    } else {
      this.receivedBy.set(hazardId, new Set([peerId]));
    }
  }

  hasReceivedBy(hazardId: string, peerId: string): boolean {
    return this.receivedBy.get(hazardId)?.has(peerId) ?? false;
  }

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

  pendingCountForPeer(peerId: string): number {
    this.prune();
    return this.hazards.filter(hazard => !this.hasReceivedBy(hazard.hazardId, peerId)).length;
  }

  forgetPeer(peerId: string): void {
    for (const peers of this.receivedBy.values()) {
      peers.delete(peerId);
    }
  }
}
