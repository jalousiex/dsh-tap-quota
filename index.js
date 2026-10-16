/**
 * dsh-tap-quota — host-side composition root.
 *
 * This is a pure-display plugin: it has no host-side config surface and no
 * service routes of its own. Its client module (lib/client.js) reads quota
 * data from the dsh-tap plugin's /dsh-tap/settings route and renders a
 * compact widget in the sidebar.footer.action slot.
 *
 * Dependency: requires dsh-tap to be installed and configured in the same
 * profile (the client module fetches from dsh-tap's HTTP endpoint).
 *
 * Host resources used:
 * - ctx.config / Schema: declares an empty config schema so the plugin
 *   manager lists it; no settings card is rendered.
 */

import z from '@deepseek-ai/schemastery'

export const Config = z.object({})

export function apply(ctx) {
  // No host-side work — the client module does everything.
  // apply() is still required so the plugin manager recognizes this as a
  // valid plugin entry and loads the client half.
}

export const name = 'dsh-tap-quota'
