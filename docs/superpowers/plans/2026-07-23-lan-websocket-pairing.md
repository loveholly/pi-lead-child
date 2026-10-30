# LAN WebSocket Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pair an Expo Go mobile device with a LAN daemon by scanning an encrypted WebSocket pairing QR code.

**Architecture:** Add shared pairing URI and encrypted-envelope utilities, a daemon identity stored in SQLite KV, a dedicated unauthenticated WebSocket pairing handshake, and a Companion scanner/client flow. After pairing, reuse the existing credential store, HTTP snapshots, and authenticated event WebSocket.

**Tech Stack:** TypeScript, TweetNaCl, Node `ws`, Expo Camera, Expo Crypto, Expo Router, Vitest.

---

### Task 1: Shared Pairing Contract and Crypto

**Files:**
- Create: `packages/protocol/src/pairing.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `test/socket-pairing-crypto.test.ts`

- [ ] Write failing round-trip and URI validation tests.
- [ ] Add strict message schemas, URI parser/builder, byte encoding, key derivation, and encrypted envelope helpers.
- [ ] Run focused tests and typecheck.

### Task 2: Pairing Store and Gateway Identity

**Files:**
- Modify: `src/store/gateway.ts`
- Test: `test/gateway.test.ts`

- [ ] Write failing tests for persistent daemon identity and atomic redeem-by-id.
- [ ] Store the daemon secret key in KV and expose only its public key.
- [ ] Add pending pairing lookup and proof-authorized atomic redemption.
- [ ] Run focused tests.

### Task 3: WebSocket Pairing Server

**Files:**
- Modify: `src/gateway/paired-server.ts`
- Create: `test/socket-pairing.test.ts`

- [ ] Write an end-to-end encrypted WebSocket pairing test.
- [ ] Add `/v1/paired/connect`, handshake timeout, strict validation, replay protection, and encrypted credential response.
- [ ] Allow loopback auto-pair on a wildcard listener only when remote address and Origin remain loopback-safe.
- [ ] Run paired protocol tests.

### Task 4: CLI Pairing QR

**Files:**
- Modify: `src/cli.ts`
- Modify: `package.json`
- Test: `test/pairing-cli.test.ts`

- [ ] Write failing CLI output/URI tests.
- [ ] Add `--endpoint`, print the URI, and render a terminal QR.
- [ ] Run focused CLI tests and build.

### Task 5: Companion Socket Pairing Client

**Files:**
- Modify: `apps/companion/src/data/controlPlaneClient.ts`
- Modify: `apps/companion/src/data/controlPlaneClient.test.ts`
- Modify: `apps/companion/package.json`

- [ ] Write a failing fake-socket handshake test.
- [ ] Implement URI pairing, encrypted challenge/confirm handling, credential persistence, timeout, and stable errors.
- [ ] Run Companion tests and typecheck.

### Task 6: Expo Go QR Scanner

**Files:**
- Modify: `apps/companion/src/app/pair.tsx`
- Create: `apps/companion/src/components/PairingScanner.tsx`
- Modify: `apps/companion/app.json`

- [ ] Add Expo Camera using the SDK-compatible installer.
- [ ] Add scanner permission, QR parsing, pairing progress, retry, and manual URI fallback.
- [ ] Configure camera and local-network permission copy.
- [ ] Run lint, typecheck, Web/iOS/Android exports.

### Task 7: LAN Runtime Verification

**Files:**
- Modify: `docs/DESIGN-GATEWAY.md`

- [ ] Build the daemon.
- [ ] Restart it on `0.0.0.0:47130` while retaining localhost auto-pair guards.
- [ ] Generate a QR for the current LAN IP.
- [ ] Verify HTTP health, socket pairing, credential use, and browser localhost auto-pair.
- [ ] Start Expo in LAN mode and report the exact Android Expo Go test steps.

