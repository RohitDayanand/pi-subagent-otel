/**
 * pi-subagents (npm, nicobailon): background runs via `subagent:async-started` /
 * `subagent:async-complete`, detection via the `subagents:rpc:v1:*` RPC.
 * Its foreground runs go through the `subagent` tool and are handled by the tool source.
 */

import { randomBytes } from "node:crypto";
import type { SpanAttributes } from "@earendil-works/pi-telemetry";
import { isRecord, num, replyVersion, str } from "../parse.ts";
import type { PackageSource, RunInfo, UnknownRecord } from "../types.ts";

function runOf(payload: UnknownRecord, id: string, attributes: SpanAttributes = {}): RunInfo {
	return {
		key: `async:${id}`,
		id,
		source: "pi-subagents",
		mode: str(payload.mode) ?? "single",
		agent: str(payload.agent),
		attributes: { "pi.subagent.background": true, ...attributes },
	};
}

export const piSubagents: PackageSource = {
	package: "pi-subagents",
	protocolVersion: 1,

	subscribe(pi, sink) {
		// Returns the payload and its run id only if it identifies a run.
		const accept = (data: unknown): { payload: UnknownRecord; id: string } | undefined => {
			sink.seen("event");
			const id = isRecord(data) ? (str(data.runId) ?? str(data.id)) : undefined;
			if (isRecord(data) && id) return { payload: data, id };
			sink.emit({ kind: "malformed" });
			return undefined;
		};

		pi.events.on("subagents:rpc:v1:ready", () => sink.seen("ready"));

		pi.events.on("subagent:async-started", (data) => {
			const accepted = accept(data);
			if (!accepted) return;
			const { payload, id } = accepted;
			const agents = Array.isArray(payload.agents)
				? payload.agents.filter((agent) => typeof agent === "string")
				: undefined;
			sink.emit({
				kind: "start",
				run: {
					...runOf(payload, id, {
						"pi.subagent.count": agents?.length ?? num(payload.chainStepCount),
						"pi.subagent.workflow_key": str(payload.workflowKey),
					}),
					sessionRoot: str(payload.sessionRoot),
					agents,
				},
			});
		});

		pi.events.on("subagent:async-complete", (data) => {
			const accepted = accept(data);
			if (!accepted) return;
			const { payload, id } = accepted;
			const state = str(payload.state);
			const failed = payload.success === false || (state !== undefined && state !== "complete");
			sink.emit({
				kind: "end",
				run: runOf(payload, id),
				results: Array.isArray(payload.results) ? payload.results.filter(isRecord) : [],
				outcome: {
					output: str(payload.summary),
					attributes: { "pi.subagent.status": state, "pi.subagent.duration_ms": num(payload.durationMs) },
					error: failed ? { type: state ?? "_OTHER", message: str(payload.error) } : undefined,
				},
				durationMs: num(payload.durationMs) ?? 0,
			});
		});
	},

	ping(pi, onReply) {
		const requestId = randomBytes(8).toString("hex");
		const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply) => onReply(replyVersion(reply)));
		pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "ping", params: {} });
		return off;
	},
};
