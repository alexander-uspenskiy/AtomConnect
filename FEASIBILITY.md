# AtomConnect: Feasibility Study

P2P messenger with chat, voice and adaptive video.

**Verdict: feasible, and mostly assembly rather than invention.** WebRTC covers media transport, congestion control, encryption, NAT traversal and codecs. We build signaling, chat, UI and TURN infrastructure around it. Library versions have not been verified; check before committing.

## Requirement mapping

| Requirement | How WebRTC handles it |
|---|---|
| P2P voice and video | `RTCPeerConnection`, SRTP/DTLS encrypted by default |
| Chat | `RTCDataChannel` (SCTP over DTLS); add server-side store for offline delivery and history |
| Adaptive video quality | Built-in congestion control (GCC/transport-cc) adapts bitrate, framerate, resolution; `degradationPreference` tunes the tradeoff |
| Adjust to screen size | `RTCRtpSender.setParameters()` (`scaleResolutionDownBy`, `maxBitrate`, `maxFramerate`); receiver reports `{width, height, dpr}` over the data channel |
| NAT traversal | ICE with STUN, TURN fallback (roughly 10-20% of connections need relay) |

## Adaptive quality

- **Basic:** default congestion control is enough for 1:1.
- **Simulcast:** 2-3 resolutions; most valuable with an SFU / group calls, little benefit for 1:1.
- **SVC:** VP9/AV1 scalability modes (e.g. `L1T3`); Chrome is solid, Safari and Firefox are patchy.
- **Receiver-driven:** viewport info over the data channel drives sender caps; optional low-data mode.
- **Audio:** Opus (6-510 kbps, FEC, DTX, PLC).

## Open-source building blocks

**Client**
- Browser WebRTC APIs (+ adapter.js if needed)
- PeerJS (prototypes), simple-peer (lightly maintained)
- flutter-webrtc, react-native-webrtc, stasel/WebRTC (iOS), Google libwebrtc (Android)
- LiveKit client SDKs (Swift, Kotlin, Flutter, JS and others)

**Server**
- coturn (TURN/STUN, required)
- LiveKit (Go SFU, Apache-2.0, simulcast and dynacast built in), best path to group calls
- mediasoup (Node/C++ SFU), Janus (C gateway)
- Pion (Go), webrtc-rs, libdatachannel, aiortc for non-browser peers
- Jitsi Meet / Videobridge (full product to fork)

**Chat / encryption**
- Matrix (Synapse/Dendrite, matrix-js-sdk, Element Call/LiveKit) for chat plus calls without building chat
- libsignal (Signal Protocol) or OpenMLS for E2EE chat

## Codecs

- Audio: Opus.
- Video: VP8/H.264 (universal; H.264 has wide hardware encode), VP9 (better compression), AV1 (best, CPU-heavy without hardware). Negotiate with `setCodecPreferences`.

## Architecture

```
Client A --signaling (WebSocket)-- Server --signaling-- Client B
   |   (SDP offer/answer, ICE candidates, presence, chat history)
   +---- media + data channel (SRTP/DTLS) ----+
         direct if possible, otherwise via coturn
```

Server components: signaling service (Node or Go WebSocket), STUN/TURN (coturn), optional message storage and push (APNs/FCM).

## Risks and costs

1. **TURN bandwidth** is the main recurring cost (about 1-2 Mbps per relayed HD call).
2. **Mobile background calls** need VoIP push + CallKit (iOS) / ConnectionService (Android); often underestimated.
3. **Browser/device fragmentation** (codecs, SVC, Safari quirks).
4. **Offline delivery**: pure P2P can't reach offline peers; needs store-and-forward, ideally E2EE.
5. **Group calls** need an SFU; full mesh degrades past 3-4 participants.
6. **Audio processing** (AEC, noise suppression) must be configured in native apps.

## Recommended paths

| Goal | Stack |
|---|---|
| Fastest MVP (days-weeks) | Web app, native WebRTC, small Node WebSocket signaling, coturn, data-channel chat |
| Production cross-platform | LiveKit (self-hosted or cloud) + SDKs; build chat, accounts, UI on top |
| Full messenger, no chat build | Matrix + Element Call |
| Maximum control | Pion / libwebrtc with custom signaling (most work) |

## Open decisions

- Target platforms: web, mobile, desktop?
- 1:1 only, or group calls later?
- Chat persistence and E2EE requirements?
- Self-hosted vs managed infrastructure?

## Proposed first prototype

1. Node signaling server (WebSocket).
2. Browser client: 1:1 video/voice + data-channel chat.
3. Adaptive controller: viewport reporting plus `getStats()` bandwidth feeding `setParameters()`.
4. coturn config for NAT fallback.
