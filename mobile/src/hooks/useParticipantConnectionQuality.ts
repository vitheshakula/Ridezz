import { useEffect, useState } from 'react';
import { ConnectionQuality, ParticipantEvent, type Participant } from 'livekit-client';

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
