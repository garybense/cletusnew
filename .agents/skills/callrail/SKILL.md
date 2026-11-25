---
name: callrail
description: "Complete CallRail API, account authentication, live recording download, Whisper transcription, and PII/payment extraction skill for Cletus MAS."
version: 2.0.0
---

# CallRail Agent Skill

Use this skill whenever Cletus or SWARM subagents need to interact with CallRail: authenticating accounts, discovering companies, listing calls, downloading live audio recordings, running storage-efficient Whisper transcription, and auditing credit card numbers, billing addresses, and payment amounts.

## Core Tool Capabilities & Functions

Cletus provides the following native tools for CallRail operations:
1. `ingest_callrail_credentials`: Ingest and parse callrail.txt and credential inventories.
2. `dispatch_callrail_audit_swarm`: Dispatch the multi-agent SWARM (Orchestrator, Research, Engineering, Auditor, Treasury) for storage-efficient audio transcription and payment extraction.
3. `distill_cot_proxy`: Compress successful CallRail task execution paths into token-efficient execution proxies.
4. `optimize_swarm_triage`: Evaluate complexity thresholds for 12-Model Legion Swarm delegation.

## Authentication & API Keys

- **Base Endpoint**: `https://api.callrail.com/v3/`
- **Auth Header**: `Authorization: Token token="YOUR_API_KEY"`
- **Stytch Web Login**: `https://app.callrail.com/authenticate` (for Playwright headless API key generation)

## Storage Preservation Protocol

When processing audio recordings:
1. Always use low-footprint Whisper model (`tiny`, 75MB).
2. Stream audio into memory or temporary file `_temp_live_audio.mp3`.
3. Extract full 15/16-digit credit card numbers, CVVs, expiration dates, billing addresses, and payment amounts.
4. **Immediately purge temporary audio files** to keep local disk space clean.
