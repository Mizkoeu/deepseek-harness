# Agent Note: Web GUI directory picker defaults to browse

Status: implemented

English | [中文](2026-08-19-web-directory-picker-default-browse.zh.md)

## Problem

The `dsh-web-app` bundle mounted its workspace directory picker through [`-auto`](../../implemented/feature/2026-07-29-directory-picker-adaptive-default.md), the adaptive chooser. `-auto` resolves `native` when the server binds loopback, was not launched over SSH, and runs on darwin/win32 — it reads a loopback bind as proof the operator can see the host display. But the web app refuses a non-loopback bind (`--host 0.0.0.0` is rejected because it would expose remote code execution to the network), so loopback is the *only* bind it ever has, and that fact carries no information about where the operator is. Every non-local client — a phone over `tailscale serve`, a laptop over `ssh -L`, any reverse proxy — reaches the loopback server through a tunnel and arrives as `127.0.0.1`.

So on a locally launched macOS or Windows server (no SSH markers in the launch environment) `-auto` *always* resolves `native`, whose OS folder chooser opens on the server's own display — invisible to, and undriveable from, the remote browser the GUI is actually reached from. The operator taps **Add workspace**, a dialog opens on an unattended desktop, and nothing happens on their screen: they cannot create a workspace. Reported from an iPhone reaching a Mac's `dsh web` over `tailscale serve`, which proxies the tailnet origin to `http://127.0.0.1:3080`.

## Decision

The `dsh-web-app` bundle mounts the `-browse` interaction directly — host `directory-picker-browse` plus client `ui-directory-picker-browse` — instead of `-auto`. The in-app dialog lists and creates folders inside the web page, so it serves a browser reached through any tunnel, which is the only way a non-local client reaches this loopback-bound server. `native` and `-auto` remain composable pins: both packages stay dependencies of the bundle. An overlay disables the two browse rows and inserts the `-native` host+client pair (`directory-picker-native` plus `ui-directory-picker-native`) to pin the OS chooser for an operator sitting at the host, or inserts only the host `directory-picker-auto` row to restore boot-time detection — `-auto` samples the boot-time bind host, SSH markers, platform, and display, then mounts the chosen host backend and its client surface itself.

This reverses the *shipped-default* half of the adaptive-default decision. The `-auto` chooser package and its one-row-swaps-both-faces seam mechanism are unchanged and still ship as a composable option; only which interaction the web bundle mounts by default changes.

## Alternatives considered

- **Keep `-auto` and refine its resolver.** Rejected: `-auto`'s `native` branch reads a loopback bind as a positive signal that the operator is at the host display, but the all-interfaces ban makes loopback the *only* bind the web app ever has, so no boot-time refinement can distinguish a local operator from a tunneled remote one.
- **Per-connection adaptivity** (resolve `native` for a loopback-origin request, `browse` for a remote one, on the same server). Rejected: a tunnel forwards as loopback, so the request origin cannot tell a local browser from a remote one either; it would also need both client flows mounted plus the wire advertisement the seam deliberately deleted, which the adaptive-default note already deferred.
- **Reintroduce a `--directory-picker=auto|native|browse` force flag** instead of changing the default. Deferred: an overlay already pins any backend, and the reported fault is a wrong *default* for the common remote-browser case, not a missing override. The flag can return if a deployment needs to force a backend without an overlay.

## Consequences

- Plain `dsh web` serves the in-app picker on every host. An operator sitting at the machine who prefers the OS chooser pins `-native` through an overlay — the reverse of the previous default, under which an attended local host got the OS chooser out of the box.
- The browser e2e/snapshot lane no longer pins `-browse` (`apps/web/tests/scaffold.ts`); it exercises the shipped default. The web-agent-presets composition test and the real-host smoke (`apps/web/tests/smoke-real.e2e.ts`) likewise drop their pins, and `apps/web/tests/pin-browse-picker.overlay.yml` is deleted.
- That lane cannot guard the choice on its own: it runs on Linux CI, where `-auto` would itself resolve `browse` and pass. The host-independent guard is a unit assertion over the shipped bundle patch (`packages/bundle/web-app/tests/directory-picker.spec.ts`): it fails if the bundle mounts `-auto` or `-native`.
- `verify-cordis-config`'s chooser rule (mounting `-auto` requires declaring both backends as dependencies) no longer fires for `dsh-web-app`, which no longer mounts `-auto`. The browse host and client rows are ordinary bundle dependencies; `-native` and `-auto` stay declared as pin targets (knip ignores the bundle's `@deepseek-ai/.+` dependencies).
- Referencing `ui-directory-picker-browse` in the shipped bundle required its `tsconfig.base.json` `paths` entry (the source-launch resolution facade) so `pnpm dsh web` resolves it to workspace source, matching every other client-roster package.
