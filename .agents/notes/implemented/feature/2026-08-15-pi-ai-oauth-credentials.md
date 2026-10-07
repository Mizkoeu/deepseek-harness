# Agent Note: pi-ai provider sign-in runs from the `dsh auth` command

Status: implemented

English | [中文](2026-08-15-pi-ai-oauth-credentials.zh.md)

## Problem

GitHub Copilot is served through the pi-ai adapter's `github-copilot` catalog route, and its only credential is an OAuth grant: a GitHub token obtained through a device flow and exchanged for a short-lived Copilot token that must be refreshed. The [credential-records and authorization-flows decision](../architecture/2026-08-13-credential-records-and-authorization-flows.md) gives that grant a home, a `grant` record keyed `llm-pi-ai/github-copilot` in `$DSH_HOME/.credentials.yaml`, and registers one `ctx.authorization` flow per pi-ai provider that ships a login. It ships no surface that begins such a flow. The only `authorization.begin()` caller is the DeepSeek account platform, for its own key, and the Models page offers no sign-in for pi-ai providers. A Copilot subscription therefore has a store and a flow but no way for a user to run the flow.

Separately, the installed pi-ai catalog trails what Copilot serves. pi-ai 0.87.1 describes `claude-opus-5.5` and `gpt-6-astra` but not `claude-sonnet-5.5` or `gpt-6.1-sol`, both of which a subscription can use.

## Decision

**`dsh auth login|status|logout <provider>` is the user entry point.** The launcher reserves `auth` as a first token, as it reserves `plugin`, and [`apps/cli/src/args.ts`](../../../../apps/cli/src/args.ts) parses its subcommands. [`apps/cli/src/auth.ts`](../../../../apps/cli/src/auth.ts) mounts a bare Cordis context, with no profile and no Loader, holding exactly what a sign-in needs: `dsh-llm`, which the adapter injects; `dsh-credentials-local` with file watching off; `dsh-authorization`; and `dsh-llm-pi-ai` with no routes. The adapter registers its flows on mount, so the command drives the same flow and writes the same record that any other surface would. The launch environment snapshot and its proxy policy are installed first, as in a profile boot, so a sign-in behind an HTTP proxy reaches the provider.

Any provider id whose installed catalog entry ships a login is accepted; an id without one is refused with the list of ids that have one. `login` begins the flow with its preferred method, OAuth when offered. A terminal interaction prints notices, with the page to open and the code to enter, and asks prompts through readline with `secret` answers hidden. Without an interactive stdin a prompt rejects with `AuthorizationDeclinedError`, so the seam settles `cancelled` instead of waiting for input that cannot arrive. Ctrl+C outside a prompt aborts the request signal; inside a prompt it declines. `--enterprise-domain` answers the text prompt pi-ai's Copilot login asks before its device flow, recognized by "enterprise" in its message, and is accepted only by `login github-copilot`; without it the prompt is asked, and an empty answer selects github.com.

`status` reports the record kind (`grant`, `api-key`, or absent) through `describeRecord`, which carries no value, so the command cannot print a token. `logout` deletes the record. The command never handles a token itself: pi-ai writes the grant through the adapter's `CredentialStore` inside `Models.login()`, and the seam confirms that commit before reporting `authorized`. `dsh-llm-pi-ai` exports `RECORD_SCOPE` so the command can select the adapter's flows from every registered flow.

After sign-in, a keyless `github-copilot` profile authenticates from the stored grant, and pi-ai refreshes it under the credential store's cross-process writer lock. The Models page saves such a profile when the key is left blank. A configured `apiKeyEnv` takes priority over the grant, which the [model guide](../../../../docs/user/guide/providers.md#sign-in-to-github-copilot) tells users to avoid.

**Uncataloged Copilot models are a catalog-data table in `dsh-llm-pi-ai`.** [`catalogModels()`](../../../../packages/llm/llm-pi-ai/src/catalog.ts) adds each `UNCATALOGED_MODELS` entry as a copy of a shipped sibling with only `id` and `name` replaced: `claude-sonnet-5.5` from `claude-sonnet-5`, and `gpt-6.1-sol` from `gpt-6-sol`. In 0.87.1 `gpt-6-sol` matches `gpt-5.6-sol` in protocol (`openai-responses`), Copilot request headers, and compat, and it carries the GPT-6 reasoning map, so it is the closer sibling. A shipped model with the same id wins, and an entry whose sibling is no longer shipped is omitted, so a pi-ai upgrade that catalogs a model makes its entry inert until someone removes it. The route's OAuth model filter still limits the served models to the ids the credential is entitled to.

## Alternatives considered

**Use an existing UI sign-in.** Rejected because none exists for pi-ai providers. `settings.models.sign-in` is the DeepSeek-account onboarding slot, and the [model guide](../../../../docs/user/guide/providers.md) stated that OAuth providers were not supported on the Models page. A Models-page control needs the wire contract for notices and prompts that the authorization decision leaves open; the command needs none.

**Boot the `web` or `headless` profile to reach `ctx.authorization`.** Rejected because a profile boot mounts sessions, tools, servers, and watchers to run one flow, requires a profile directory, and can collide with a running Web server. The four-plugin context mounts nothing a sign-in does not use.

**Keep a pi-ai-specific credential file and call pi-ai's login directly.** Rejected because the harness stores pi-ai grants as `llm-pi-ai/<provider>` records in the shared credential document, which every adapter instance reads and refreshes. A second file would split one credential across two stores, and calling `Models.login()` directly would skip the seam's single-attempt rule and commit confirmation.

**Answer the Copilot enterprise prompt blank by default.** Rejected because it would hard-code one provider's question into a generic relay and hide it from the user. An interactive user presses Enter for github.com.

**Declare the missing models in route configuration.** Rejected because no profile field can express them. A `models` entry for an id the catalog does not describe takes the route's shared protocol, and `github-copilot` spans `anthropic-messages`, `openai-responses`, and `openai-completions`, so resolution demands a route-level `api`. Setting one repoints every model on the route to that protocol and drops the per-model Copilot headers and compat, while the `models` list replaces the whole catalog. `modelOverrides` reshapes only models the catalog already describes.

**Make the table a validated `Config` field.** Rejected because which models a provider serves is catalog data, the same fact pi-ai's catalog records for every other model, not a deployment-varying choice; a deployment still chooses what to show through the route's `models` list. A config field would also expose a sibling-copy concept whose correctness depends on pi-ai's internal model descriptor fields.

**Upgrade pi-ai until it catalogs the models.** Not available: 0.87.1 is the current dependency and still lacks both ids. An upgrade remains the way to retire table entries.

## Consequences

A Copilot subscription signs in once with `dsh auth login github-copilot` and serves a keyless `github-copilot` route across restarts; a running Web server sees the new record through the credential store's file watch. The same command signs in to every pi-ai provider with a login, including `openai-codex`. The CLI runtime now depends on `dsh-authorization`, `dsh-credentials`, `dsh-credentials-local`, `dsh-llm`, and `dsh-llm-pi-ai`. The `--enterprise-domain` match depends on the wording of pi-ai's Copilot prompt; if that wording changes, the flag stops matching and the question is asked instead. A sign-in without an interactive terminal succeeds only when flags answer every prompt, which today means a GitHub Enterprise Copilot login.

The uncataloged table must be pruned by hand after pi-ai upgrades; a stale entry is harmless because shipped descriptors win. A copied model inherits its sibling's capacities and pricing metadata, which may differ from the new model's.

Unit tests drive the command against a fake host (device-code relay, the enterprise answer, interrupt, failure causes, status kinds, logout, unknown providers) and mount the real four-plugin host over a temporary `DSH_HOME`. Argument tests pin the grammar. The built-bin test checks the launcher help and runs `dsh auth status github-copilot` on an empty home. Catalog tests cover the copies' descriptors, their presence on an unconfigured route, shipped-descriptor precedence, and a missing sibling. A live device flow was checked by hand up to the printed code; no automated test signs in to GitHub.
