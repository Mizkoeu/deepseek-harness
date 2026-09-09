# Agent Note: pi-ai provider OAuth uses a structured local credential store

Status: implemented

English | [中文](2026-08-15-pi-ai-oauth-credentials.zh.md)

## Problem

The multi-provider adapter exposes pi-ai's installed provider catalog but resolved authentication only through a Harness `apiKeyEnv` string or pi-ai's ambient environment discovery. pi-ai OAuth credentials contain a refresh token, short-lived access token, expiry, and provider-specific metadata that must change together. The Harness string credential service cannot preserve that record or serialize refresh, so GitHub Copilot appeared in the Models catalog while a Copilot subscription had no durable login path and a pasted access token expired without refresh.

## Decision

`@deepseek-ai/dsh-llm-pi-ai` owns a file-backed implementation of pi-ai's `CredentialStore`. The JSON document lives at `$DSH_HOME/.pi-ai-credentials.json`, validates its durable input without quoting secret values, and is atomically replaced at `0600`; a newly created Harness home requests `0700`. Each mutation re-reads the complete document under the shared cross-process writer lock before replacing one provider record, so concurrent login, logout, and OAuth refresh cannot resurrect an older token. Lock-free readers see either the complete prior document or the complete replacement.

Every immutable `Models` route snapshot receives the same credential store. A profile with `apiKeyEnv` still resolves that Harness credential per request and passes it as pi-ai's highest-priority direct-key override. A profile without `apiKeyEnv` lets pi-ai resolve a stored OAuth credential or its provider-native ambient authentication. pi-ai performs expiry checks and refresh inside `CredentialStore.modify()`, preserving the provider record if refresh fails. The configurable-provider directory consequently includes installed providers that authenticate only through OAuth.

The product launcher owns the user interaction through `dsh auth login|status|logout github-copilot`. Login invokes pi-ai's installed GitHub Copilot OAuth method, supplies the public-GitHub or explicit enterprise domain, prints provider device-code and progress events, and persists only after the complete provider flow succeeds. Status reads non-secret metadata without refresh, and logout removes the provider entry atomically. The [model configuration guide](../../../../docs/user/guide/providers.md) requires a keyless GitHub Copilot profile after login, because setting `apiKeyEnv` would deliberately bypass the OAuth exchange and refresh path.

The owner-only filesystem mode prevents access by other OS users, not by agent tools running as the same user. The adapter and launcher do not reveal the resolved path or document contents to the model, but a tool with read access to the Harness home can read the file.

## Alternatives considered

**Store the OAuth record as a string in `.credentials.yaml`.** Rejected because the credential service intentionally maps one reference to one opaque string. Encoding mutable provider JSON inside it would hide refresh concurrency and provider metadata behind a contract that cannot expose either.

**Ask users to paste a Copilot access token into the Models API-key field.** Rejected because the token produced by GitHub's Copilot exchange is short-lived. A static field cannot retain the GitHub refresh token or replace the access token before later requests.

**Ship a replacement out-of-tree LLM adapter.** Rejected because it would duplicate message conversion, replay validation, timeout handling, attribution, and stream normalization solely to inject pi-ai's credential store. The existing adapter is the owner of those behaviors and accepts the store directly.

**Integrate GitHub's Copilot SDK instead of pi-ai OAuth.** Rejected because that SDK drives a Copilot agent process, while this feature authenticates a model provider underneath the Harness-owned agent loop and tools. pi-ai already owns the required provider protocol and token exchange.

**Add a provider-neutral authentication Service Definition immediately.** Rejected because GitHub Copilot is the only current product login Consumer. The exported setup operations and pi-ai `CredentialStore` injection provide the current extension point without inventing a capability with no second provider or UI Consumer; another native-login experience can justify the complete Service Definition / Service Provider / Consumer seam.

## Consequences

A GitHub Copilot subscription can authenticate once through device flow and serve keyless Copilot profiles across restarts; pi-ai refreshes the short-lived access token from the stored GitHub token. Direct API-key profiles preserve their existing precedence and fail-loud references. The CLI depends directly on the adapter's auth entry point, and the adapter package owns another durable secret document whose validation, locking, permissions, and compatibility must be maintained. The on-disk JSON has no compatibility promise before the first tagged release.

Focused storage tests cover owner-only writes, invalid durable input, cross-instance mutation, refresh, and deletion. A mocked provider flow covers device exchange and persistence, an adapter request covers stored-OAuth dispatch, the real Loader composition covers the OAuth-capable catalog entry, and the built CLI test covers keyless status without booting a profile.
