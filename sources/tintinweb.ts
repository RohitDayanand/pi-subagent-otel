/**
 * @tintinweb/pi-subagents: `subagents:*` lifecycle events on `pi.events`
 * (created / started / completed / failed / steered / compacted / ready), ping on `subagents:rpc:ping`.
 */

import { randomBytes } from "node:crypto";
import { isRecord, num, replyVersion, str } from "../parse.ts";
import type { PackageSource, RunInfo, RunOutcome, UnknownRecord } from "../types.ts";

const KNOWN_ERROR_STATUSES = new Set(["error", "aborted", "stopped"]);

type BusPayload = UnknownRecord & { id: string };

function busOutcome(payload: BusPayload, failed: boolean): RunOutcome {
	const status = str(payload.status);
	const errorType = status !== undefined && KNOWN_ERROR_STATUSES.has(status) ? status : undefined;
	return {
		// `tokens` is the display count ({ input, output, total }); used only when `usage` is missing.
		usage: isRecord(payload.usage) ? payload.usage : payload.tokens,
		output: str(payload.result),
		attributes: {
			"pi.subagent.status": status,
			"pi.subagent.duration_ms": num(payload.durationMs),
			"pi.subagent.tool_uses": num(payload.toolUses),
		},
		error: failed || errorType ? { type: errorType ?? "_OTHER", message: str(payload.error) } : undefined,
	};
}

function runOf(payload: BusPayload): RunInfo {
	return {
		key: `bus:${payload.id}`,
		id: payload.id,
		source: "pi-subagents",
		mode: "single",
		agent: str(payload.type),
		description: str(payload.description),
	};
}

export const tintinweb: PackageSource = {
	package: "@tintinweb/pi-subagents",
	protocolVersion: 2,

	subscribe(pi, sink, now) {
		const queued = new Map<string, { createdAtMs: number; background?: boolean }>();

		// Returns the payload only if it identifies a subagent.
		const accept = (data: unknown): BusPayload | undefined => {
			sink.seen("event");
			if (isRecord(data) && str(data.id)) return data as BusPayload;
			sink.emit({ kind: "malformed" });
			return undefined;
		};

		const finish = (data: unknown, failed: boolean) => {
			const payload = accept(data);
			if (!payload) return;
			queued.delete(payload.id);
			sink.emit({
				kind: "end",
				run: runOf(payload),
				outcome: busOutcome(payload, failed),
				durationMs: num(payload.durationMs) ?? 0,
			});
		};

		pi.events.on("subagents:ready", () => sink.seen("ready"));
		pi.events.on("subagents:created", (data) => {
			const payload = accept(data);
			if (!payload) return;
			queued.set(payload.id, {
				createdAtMs: now(),
				background: typeof payload.isBackground === "boolean" ? payload.isBackground : undefined,
			});
		});
		pi.events.on("subagents:started", (data) => {
			const payload = accept(data);
			if (!payload) return;
			const created = queued.get(payload.id);
			sink.emit({
				kind: "start",
				run: {
					...runOf(payload),
					attributes: {
						"pi.subagent.background": created?.background,
						"pi.subagent.queued_ms": created ? now() - created.createdAtMs : undefined,
					},
				},
			});
		});
		pi.events.on("subagents:completed", (data) => finish(data, false));
		pi.events.on("subagents:failed", (data) => finish(data, true));
		pi.events.on("subagents:steered", (data) => {
			const payload = accept(data);
			if (!payload) return;
			sink.emit({
				kind: "event",
				key: `bus:${payload.id}`,
				name: "pi.subagent.steered",
				attributes: { "pi.subagent.message": str(payload.message) },
			});
		});
		pi.events.on("subagents:compacted", (data) => {
			const payload = accept(data);
			if (!payload) return;
			sink.emit({
				kind: "event",
				key: `bus:${payload.id}`,
				name: "pi.subagent.compacted",
				attributes: {
					"pi.compaction.reason": str(payload.reason),
					"pi.compaction.tokens_before": num(payload.tokensBefore),
					"pi.compaction.count": num(payload.compactionCount),
				},
			});
		});
	},

	ping(pi, onReply) {
		const requestId = randomBytes(8).toString("hex");
		const off = pi.events.on(`subagents:rpc:ping:reply:${requestId}`, (reply) => onReply(replyVersion(reply)));
		pi.events.emit("subagents:rpc:ping", { requestId });
		return off;
	},
};
