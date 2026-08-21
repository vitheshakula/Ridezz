# Ridezz server

Not built yet. This will become a small Node.js + TypeScript service whose
only job (for the MVP) is issuing short-lived LiveKit access tokens to the
mobile app, so the LiveKit API secret never has to live on-device.

Until this exists, the mobile app uses LiveKit's development token flow for
bring-up/testing only.
