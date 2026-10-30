# LAN WebSocket Pairing Design

## Goal

Allow an Android or iOS device running the Companion app in Expo Go to scan a QR code and securely pair with a pi-lead-child daemon on the same LAN.

## Scope

- Direct LAN WebSocket pairing at `/v1/paired/connect`.
- QR payload containing the LAN WebSocket endpoint, one-time pairing offer, and daemon public key.
- X25519 shared-secret derivation and XSalsa20-Poly1305 authenticated encryption via TweetNaCl.
- Persistent Companion credentials stored through the existing native SecureStore adapter.
- Existing authenticated HTTP snapshots and WebSocket event transport remain unchanged after pairing.
- Existing browser localhost auto-pair remains supported when the gateway listens on `0.0.0.0`.

Out of scope for this iteration: mDNS discovery, public relay infrastructure, remote Internet pairing, and migration of snapshots from HTTP to WebSocket commands.

## Pairing Flow

1. The owner runs `plc pair new --name <device> --endpoint ws://<lan-ip>:47130`.
2. The CLI creates the existing one-time pairing row, retrieves the daemon X25519 public key, prints a `plc-pair://` URI, and renders it as a terminal QR code.
3. The Companion scans or pastes the URI and opens `/v1/paired/connect`.
4. The client sends `pair.hello` with the public pairing id and an ephemeral client public key.
5. Both sides derive a key from X25519 plus the SHA-256 hash of the one-time pairing code. The code itself is never sent over the socket.
6. The daemon sends an encrypted challenge. The Companion validates that the daemon owns the private key corresponding to the QR public key.
7. The Companion returns an encrypted confirmation containing the challenge and device name.
8. The daemon atomically redeems the pairing row and returns the binding and access token in an encrypted response.
9. The Companion stores the credentials, closes the pairing socket, and starts the existing snapshot/event connection.

## Security Boundaries

- Pairing offers expire after 15 minutes and are single-use.
- The QR pairing code acts as a pre-shared secret and is mixed into the ECDH-derived key.
- A captured LAN packet does not expose the pairing code or issued access token.
- The daemon public key in the QR prevents a LAN man-in-the-middle from impersonating the selected daemon.
- Invalid messages, replayed confirmations, expired offers, and mismatched daemon keys fail closed.
- Binding revocation continues to use `plc pair revoke`.

## Expo Go UX

- Native pairing screen offers `扫描二维码` and keeps the existing manual endpoint/code fallback.
- `expo-camera` scans `plc-pair://` QR values.
- Camera permission denial leaves manual paste available.
- Expo Go uses built-in WebSocket support; no raw TCP native module is required.

