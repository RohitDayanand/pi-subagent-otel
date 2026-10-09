/**
 * Subagent OTel - Map subagent invocations to OpenTelemetry GenAI agent spans
 *
 * Data flow:
 *   bus / tool payload -> sources/* -> SourceEvent -> instrumentation -> tracer -> listeners
 *
 *   sources/tintinweb.ts     @tintinweb/pi-subagents lifecycle events + ping
 *   sources/pi-subagents.ts  pi-subagents (npm, nicobailon) background runs + v1 RPC ping
 *   sources/tool.ts          `subagent` tool calls (bundled example, pi-subagents foreground runs)
 *   detection.ts             whether a subagent extension is on the bus
 *   instrumentation.ts       run events -> GenAI span names, attributes and tree shape
 *   tracer.ts                generic span store, mirrored into pi-telemetry
 *   render.ts                footer status and `/subagent-trace` tree
 *   file-exporter.ts         dated JSON trace file
 *
 * If no subagent extension is on the bus, the trace reports the source as `absent` instead of
 * silently returning an empty tree. One that loads later is picked up through its ready signal or
 * first lifecycle event. Prompts, task text and results are never recorded.
 *
 * Getting the trace back:
 *   - the footer shows the detection state and span count; a one-time notice appears when
 *     no subagent extension is found
 *   - `/subagent-trace` renders the span tree; `/subagent-trace json` shows the raw trace
 *   - `pi.events.emit("subagent-otel:rpc:trace", { requestId })` replies on
 *     `subagent-otel:rpc:trace:reply:{requestId}` with `{ success: true, data: SubagentTrace }`
 *   - every finished span is emitted on `subagent-otel:span`
 *   - pass `telemetry` to `createSubagentOtelExtension()` to forward spans to any pi-telemetry
 *     adapter (e.g. an OTLP exporter)
 *   - `--subagent-otel-exporter file` writes the trace to `<dir>/<YYYY-MM-DD>-<name>.json`.
 *     `make subagent-otel NAME=explore` passes that exporter (the default) and the name.
 */

import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerChildExtension } from "./child-registration.ts";
import { createDetection, PACKAGE_SOURCES } from "./detection.ts";
import { registerFileExporterFlags, resolveTraceFile } from "./file-exporter.ts";
import { CONTENT_ATTRIBUTES, createInstrumentation } from "./instrumentation.ts";
import { isRecord, str } from "./parse.ts";
import { renderTrace, statusText } from "./render.ts";
import { subscribeToConversation } from "./sources/conversation.ts";
import { FLEET_SOCKET_ENV, startFleetServer } from "./sources/fleet-ipc.ts";
import { subscribeToSubagentTool } from "./sources/tool.ts";
import { createTracer } from "./tracer.ts";
import type { FleetServer, SubagentOtelOptions, SubagentTrace, TraceFile, TraceFileRecord } from "./types.ts";

export function createSubagentOtelExtension(options: SubagentOtelOptions = {}) {
	const now = options.now ?? Date.now;
	const detectTimeoutMs = options.detectTimeoutMs ?? 500;
	const toolNames = new Set(options.toolNames ?? ["subagent"]);

	return function subagentOtel(pi: ExtensionAPI) {
		// Set in pi-subagents runner processes. There `child.ts` reports to the parent instead.
		if (process.env.PI_SUBAGENT_CHILD === "1") return;
		registerFileExporterFlags(pi);
		pi.registerFlag("subagent-otel-content", {
			description: "Record prompts, responses, reasoning and tool arguments/results: none (default) or full",
			type: "string",
		});

		let ui: ExtensionContext["ui"] | undefined;
		let traceFile: TraceFile | undefined;
		let conversationId: string | undefined;
		let fleet: FleetServer | undefined;
		let unregisterChild: (() => void) | undefined;
		/** Set from `--subagent-otel-content` at session start. */
		let captureContent = false;

		const tracer = createTracer({
			telemetry: options.telemetry,
			now,
			recordAttribute: (key) => captureContent || !CONTENT_ATTRIBUTES.has(key),
			retainAttribute: (key) => !CONTENT_ATTRIBUTES.has(key),
		});
		const instrumentation = createInstrumentation(tracer, now, () => conversationId);
		const detection = createDetection(() => refreshStatus());

		function snapshot(): SubagentTrace {
			return {
				traceId: tracer.traceId,
				source: { ...detection.status },
				spans: tracer.spans(),
				dropped: instrumentation.dropped,
				file: traceFile?.path,
			};
		}

		function notify(message: string, level: "info" | "error") {
			try {
				ui?.notify(`subagent-otel: ${message}`, level);
			} catch {
				// The UI may already be torn down.
			}
		}

		function refreshStatus() {
			try {
				ui?.setStatus("subagent-otel", statusText(snapshot()));
			} catch {
				// The UI may already be torn down.
			}
		}

		function writeTraceFile(record: TraceFileRecord) {
			try {
				traceFile?.append(record);
			} catch (error) {
				console.error("subagent-otel export error:", error);
			}
		}

		const traceRecord = (): TraceFileRecord => ({
			type: "trace",
			traceId: tracer.traceId,
			source: { ...detection.status },
			dropped: instrumentation.dropped,
			timeMs: now(),
			process: { pid: process.pid, hostname: os.hostname() },
		});

		// Before the tool source, so a `subagent` call's execute_tool span exists when its run starts.
		subscribeToConversation(pi, (event) =>
			instrumentation.handle({ kind: "conversation", scope: { kind: "parent" }, event }),
		);
		for (const source of PACKAGE_SOURCES) {
			source.subscribe(
				pi,
				{ emit: (event) => instrumentation.handle(event), seen: (via) => detection.mark(source, via) },
				now,
			);
		}
		subscribeToSubagentTool(pi, (event) => instrumentation.handle(event), toolNames);
		tracer.onSpanEnd((span) => {
			writeTraceFile({ type: "span", span });
			pi.events.emit("subagent-otel:span", span);
			refreshStatus();
		});

		pi.events.on("subagent-otel:rpc:trace", (data) => {
			const requestId = isRecord(data) ? str(data.requestId) : undefined;
			if (!requestId) return;
			pi.events.emit(`subagent-otel:rpc:trace:reply:${requestId}`, { success: true, data: snapshot() });
		});

		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) ui = ctx.ui;
			try {
				conversationId = ctx.sessionManager.getSessionId();
			} catch {
				// Session id is optional enrichment.
			}
			try {
				fleet ??= startFleetServer((event) => instrumentation.handle(event));
				process.env[FLEET_SOCKET_ENV] = fleet.path;
				const registration = conversationId ? registerChildExtension(conversationId) : undefined;
				if (registration && "error" in registration) notify(registration.error, "error");
				else unregisterChild = registration?.unregister;
			} catch (error) {
				notify(
					`subagent conversations will not be traced live: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			const content = str(pi.getFlag("subagent-otel-content")) ?? "none";
			if (content !== "none" && content !== "full") {
				notify(
					`unknown --subagent-otel-content "${content}" (supported: none, full); recording no content`,
					"error",
				);
			}
			captureContent = content === "full";
			let resolved: ReturnType<typeof resolveTraceFile>;
			try {
				resolved = resolveTraceFile(pi, {
					cwd: ctx.cwd,
					sessionFile: ctx.sessionManager.getSessionFile(),
					nowMs: now(),
				});
			} catch (error) {
				resolved = { error: `cannot create trace file: ${error instanceof Error ? error.message : String(error)}` };
			}
			if (resolved && "error" in resolved) {
				notify(resolved.error, "error");
			} else if (resolved) {
				traceFile = resolved.file;
				writeTraceFile(traceRecord());
				notify(`writing trace to ${traceFile.path}`, "info");
			}
			refreshStatus();
			detection.probe(pi, detectTimeoutMs, () =>
				notify(
					"no subagent extension found on the bus (checked @tintinweb/pi-subagents and pi-subagents). " +
						"Only the `subagent` tool will be traced. Run /subagent-trace for details.",
					"info",
				),
			);
		});

		pi.on("session_shutdown", () => {
			detection.stop();
			unregisterChild?.();
			unregisterChild = undefined;
			if (fleet && process.env[FLEET_SOCKET_ENV] === fleet.path) delete process.env[FLEET_SOCKET_ENV];
			fleet?.close();
			fleet = undefined;
			instrumentation.shutdown("pi.session_shutdown");
			writeTraceFile(traceRecord());
			traceFile = undefined;
			ui = undefined;
		});

		pi.registerCommand("subagent-trace", {
			description: "Show the OTel trace (add 'json' for raw span summaries; full content is in the trace file)",
			handler: async (args, ctx) => {
				const trace = snapshot();
				const text = args.trim() === "json" ? JSON.stringify(trace, null, 2) : renderTrace(trace);
				ctx.ui.notify(text, "info");
			},
		});
	};
}

export default createSubagentOtelExtension();
