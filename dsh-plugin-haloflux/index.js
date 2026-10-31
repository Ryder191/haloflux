/**
 * HALOFLUX for DSH — Host half.
 *
 * The decoration renders entirely in the Web client (`client.js`, registered
 * into the `shell.overlay` slot and reading the live session from
 * `ctx.sessions`). This Host half exists so the bundle has an activatable row
 * and a visible inventory entry; it deliberately has no Host behaviour.
 *
 * Tunables (opacity, idle motion, console visibility, all 74 visual
 * parameters) live in the in-page console and in localStorage, so they
 * survive Host upgrades without a config schema.
 */

export function apply() {}