/** Narrowing helpers for untyped bus and tool payloads. */

import type { UnknownRecord } from "./types.ts";

export function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null;
}

export function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Non-empty strings only. */
export function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Protocol version from a `{ success, data: { version } }` ping reply. */
export function replyVersion(reply: unknown): number | undefined {
	return isRecord(reply) && reply.success !== false && isRecord(reply.data) ? num(reply.data.version) : undefined;
}
