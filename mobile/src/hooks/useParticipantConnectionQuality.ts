import { useEffect, useState } from 'react';
import { ConnectionQuality, ParticipantEvent, type Participant } from 'livekit-client';

/** components-react doesn't publicly export a per-participant connection-quality
 * hook (only a "connection quality indicator" one scoped to the participant
 * context), so this subscribes directly to the SDK's own
 * ParticipantEvent.ConnectionQualityChanged -- real LiveKit data, not inferred. */
export function useParticipantConnectionQuality(participant: Participant): ConnectionQuality {
  const [quality, setQuality] = useState(participant.connectionQuality);

  useEffect(() => {
    setQuality(participant.connectionQuality);
    const handleChange = (q: ConnectionQuality) => setQuality(q);
    participant.on(ParticipantEvent.ConnectionQualityChanged, handleChange);
    return () => {
      participant.off(ParticipantEvent.ConnectionQualityChanged, handleChange);
    };
  }, [participant]);

  return quality;
}
