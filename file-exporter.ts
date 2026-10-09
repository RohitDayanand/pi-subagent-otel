/**
 * Append-only trace file: one JSON line per finished span, with full content, written when the span
 * ends. Memory keeps only summaries, so this file is the complete record.
 *
 * Location, in order:
 *   - `--subagent-otel-dir` / `--subagent-otel-name` given: `<dir>/<YYYY-MM-DD>-<name>.jsonl`
 *   - the session has a file: next to it, `<session>.otel.jsonl`
 *   - otherwise (in-memory session): no file
 * `--subagent-otel-exporter none` turns the file off.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { str } from "./parse.ts";
import type { TraceFile, TraceFileRecord } from "./types.ts";

const DEFAULT_TRACE_DIR = "subagent-traces";

export function registerFileExporterFlags(pi: ExtensionAPI): void {
	pi.registerFlag("subagent-otel-exporter", {
		description: "Trace file exporter: file (default) or none",
		type: "string",
	});
	pi.registerFlag("subagent-otel-name", {
		description: "Name for a dated trace file in --subagent-otel-dir instead of next to the session file",
		type: "string",
	});
	pi.registerFlag("subagent-otel-dir", {
		description: `Directory for a dated trace file instead of next to the session file (default with --subagent-otel-name: ${DEFAULT_TRACE_DIR})`,
		type: "string",
	});
}

/** Keep the name inside one path segment. Slashes and other separators become hyphens. */
function sanitizeTraceName(name: string): string {
	const cleaned = name
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return "trace";
	return cleaned.slice(0, 80);
}

/** `<directory>/<YYYY-MM-DD>-<name>.jsonl`, dated by local calendar day so it matches the day the session started. */
export function traceFilePath(directory: string, name: string, nowMs: number): string {
	const date = new Date(nowMs);
	const day = [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
	return path.join(directory, `${day}-${sanitizeTraceName(name)}.jsonl`);
}

/**
 * Trace file selected by the flags and session, an error for an unknown exporter, or undefined when
 * there is nowhere to write.
 */
export function resolveTraceFile(
	pi: ExtensionAPI,
	session: { cwd: string; sessionFile: string | undefined; nowMs: number },
): { file: TraceFile } | { error: string } | undefined {
	const exporter = str(pi.getFlag("subagent-otel-exporter")) ?? "file";
	if (exporter === "none") return undefined;
	if (exporter !== "file") return { error: `unknown exporter "${exporter}" (supported: file, none)` };
	const name = str(pi.getFlag("subagent-otel-name"));
	const directory = str(pi.getFlag("subagent-otel-dir"));
	const filePath =
		name || directory
			? traceFilePath(path.resolve(session.cwd, directory ?? DEFAULT_TRACE_DIR), name ?? "trace", session.nowMs)
			: session.sessionFile && `${session.sessionFile.replace(/\.jsonl$/, "")}.otel.jsonl`;
	if (!filePath) return undefined;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	return {
		file: {
			path: filePath,
			// Synchronous so a line is on disk before the next one starts and survives a crash.
			append(record: TraceFileRecord): void {
				fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
			},
		},
	};
}
