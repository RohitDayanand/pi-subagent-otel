/**
 * Makes pi-subagents load `child.ts` into every child of this session: foreground, async and nested.
 *
 * pi-subagents exposes this as `registerRequiredChildExtensions` (export
 * `pi-subagents/required-child-extensions`), backed by a versioned registry on `globalThis`. This
 * writes the same v1 shape directly so the example loads without pi-subagents installed.
 */

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const REGISTRY_KEY = Symbol.for("pi-subagents.required-child-extensions.v1");
const EXTENSION_ID = "subagent-otel";

type RequiredExtension = Readonly<{ id: string; path: string }>;
type Registry = { version: 1; bySession: Map<string, readonly RequiredExtension[]> };

function registry(): Registry | undefined {
	const root = globalThis as Record<symbol, unknown>;
	const existing = root[REGISTRY_KEY];
	if (existing === undefined) {
		const created: Registry = { version: 1, bySession: new Map() };
		root[REGISTRY_KEY] = created;
		return created;
	}
	const candidate = existing as Partial<Registry>;
	return candidate.version === 1 && candidate.bySession instanceof Map ? (existing as Registry) : undefined;
}

/**
 * Register `child.ts` for children of `sessionId`, alongside any extensions another extension already
 * registered. Returns an unregister function, or an error when the registry has an unknown shape.
 */
export function registerChildExtension(sessionId: string): { unregister: () => void } | { error: string } {
	const store = registry();
	if (!store) return { error: "unsupported pi-subagents required-child-extension registry" };
	const entry: RequiredExtension = Object.freeze({
		id: EXTENSION_ID,
		path: fs.realpathSync(fileURLToPath(new URL("./child.ts", import.meta.url))),
	});
	const others = (store.bySession.get(sessionId) ?? []).filter((extension) => extension.id !== EXTENSION_ID);
	store.bySession.set(sessionId, Object.freeze([...others, entry]));
	return {
		unregister() {
			const current = store.bySession.get(sessionId) ?? [];
			const rest = current.filter((extension) => extension.id !== EXTENSION_ID);
			if (rest.length > 0) store.bySession.set(sessionId, Object.freeze(rest));
			else store.bySession.delete(sessionId);
		},
	};
}
