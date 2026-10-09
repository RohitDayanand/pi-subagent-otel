/** Types shared by the subagent-otel modules. Logic lives in the sibling files. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AttributeValue, SpanAttributes, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";

export type UnknownRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Public trace: RPC reply, `/subagent-trace json`, file exporter
// ---------------------------------------------------------------------------

export type SubagentPackage = "@tintinweb/pi-subagents" | "pi-subagents";

export type SubagentSourceState = "unknown" | "detected" | "absent" | "incompatible";

export interface SubagentSourceStatus {
	state: SubagentSourceState;
	/** Which subagent extension was found on the bus. */
	package?: SubagentPackage;
	/** How the source was detected. */
	via?: "ping" | "ready" | "event";
	/** Protocol version reported by the package's ping. */
	version?: number;
}

export interface SubagentTraceEvent {
	name: string;
	timeMs: number;
	attributes: Record<string, AttributeValue>;
}

export interface SubagentTraceSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: "INTERNAL";
	startTimeMs: number;
	endTimeMs?: number;
	attributes: Record<string, AttributeValue>;
	events: SubagentTraceEvent[];
	status: { code: "UNSET" | "OK" | "ERROR"; message?: string };
}

export interface SubagentTrace {
	traceId: string;
	source: SubagentSourceStatus;
	/** Spans in start order. Open spans have no `endTimeMs`. */
	spans: SubagentTraceSpan[];
	/** Bus payloads dropped because they had no usable `id`. */
	dropped: number;
	/** Trace file holding every finished span with full content. `spans` here are summaries without content. */
	file?: string;
}

export interface SubagentOtelOptions {
	/** Optional pi-telemetry context to forward spans to. Spans are always kept in the local trace. */
	telemetry?: TelemetryContext;
	/** How long to wait for a ping reply before reporting the bus source absent. */
	detectTimeoutMs?: number;
	/** Tool names handled by the tool source. */
	toolNames?: readonly string[];
	now?: () => number;
}

// ---------------------------------------------------------------------------
// Subagent runs
// ---------------------------------------------------------------------------

/** One subagent run: a single agent, or a parallel / chain / workflow invocation. */
export interface RunInfo {
	/** Unique across sources, e.g. `bus:{id}`. Keys the run's span. */
	key: string;
	/** Transient run id, recorded as `pi.subagent.id`. */
	id: string;
	/** Recorded as `pi.subagent.source`. */
	source: "pi-subagents" | "tool";
	/** "single", or a workflow mode such as "parallel" or "chain". */
	mode: string;
	agent?: string;
	description?: string;
	/** Task text given to the subagent, when the source has it. */
	input?: string;
	/** The parent's `subagent` tool call that started this run. Its `execute_tool` span becomes the parent. */
	launchToolCallId?: string;
	/**
	 * Directory holding this run's child sessions as `run-<index>/session.jsonl`. Lets a child that
	 * connects over the fleet socket be matched to this run.
	 */
	sessionRoot?: string;
	/** Agent per child index, for workflow runs. */
	agents?: readonly string[];
	/** Extra `pi.subagent.*` start attributes. */
	attributes?: SpanAttributes;
}

/** How a run, or one agent within it, ended. */
export interface RunOutcome {
	/** pi `Usage`-shaped object (input, output, cacheRead, cacheWrite, cost). */
	usage?: unknown;
	/** Final text the subagent returned. */
	output?: string;
	/** Extra `pi.subagent.*` end attributes. */
	attributes?: SpanAttributes;
	/** `type` becomes the low-cardinality `error.type`; `message` the span status message. */
	error?: { type: string; message?: string };
}

// ---------------------------------------------------------------------------
// Conversations: the parent's and each child's LLM and tool calls
// ---------------------------------------------------------------------------

/**
 * Whose conversation an event belongs to. A child is identified by its session, because it does not
 * reliably know its run id; the parent matches the session to a run (see DESIGN.md, correlation).
 */
export type ConversationScope =
	| { kind: "parent" }
	/** `pid` is the process the child runs in: the parent's own for foreground children. */
	| { kind: "child"; sessionId: string; sessionFile?: string; pid?: number };

/**
 * One step of a conversation. Content fields hold pi message and tool payloads as-is.
 * `timeMs` is set when the event happened earlier than it is delivered (IPC, session-file rebuild);
 * live events in the parent omit it.
 */
export type ConversationEvent =
	/** One user prompt, from `agent_start` to `agent_end`. `messages` are the ones this prompt produced. */
	| { kind: "agent.start"; timeMs?: number }
	| { kind: "agent.end"; messages?: unknown; timeMs?: number }
	/**
	 * One provider request. `callKey` pairs start and end within one conversation. `messages` is the
	 * transcript sent, system messages included.
	 */
	| { kind: "llm.start"; callKey: string; provider?: string; model?: string; messages?: unknown; timeMs?: number }
	| {
			kind: "llm.end";
			callKey: string;
			responseModel?: string;
			responseId?: string;
			/** The pi assistant message returned. */
			output?: unknown;
			/** pi `Usage`-shaped object. */
			usage?: unknown;
			stopReason?: string;
			error?: { type: string; message?: string };
			timeMs?: number;
	  }
	| { kind: "tool.start"; toolCallId: string; toolName: string; arguments?: unknown; timeMs?: number }
	| { kind: "tool.end"; toolCallId: string; result?: unknown; isError: boolean; timeMs?: number };

/** Child-to-parent socket messages, one JSON object per line. */
export type FleetMessage =
	| { v: 1; type: "hello"; sessionId: string; sessionFile?: string; pid: number }
	| { v: 1; type: "event"; event: ConversationEvent }
	| { v: 1; type: "bye" };

// ---------------------------------------------------------------------------
// Sources -> instrumentation
// ---------------------------------------------------------------------------

/** What every source emits. Only instrumentation turns these into spans. */
export type SourceEvent =
	| { kind: "conversation"; scope: ConversationScope; event: ConversationEvent }
	| { kind: "start"; run: RunInfo }
	| {
			kind: "end";
			run: RunInfo;
			outcome: RunOutcome;
			/** Per-agent result rows. Omitted when the source has none to roll up. */
			results?: UnknownRecord[];
			/** Lets a start we never saw be rebuilt. Without it, an end for an unknown run is ignored. */
			durationMs?: number;
	  }
	| { kind: "event"; key: string; name: string; attributes?: SpanAttributes }
	/** Drop the run's span, e.g. a tool call that only launched a run traced by another source. */
	| { kind: "discard"; key: string; reason: string }
	/** A payload without a usable id. Counted in `SubagentTrace.dropped`. */
	| { kind: "malformed" };

export interface SourceSink {
	emit(event: SourceEvent): void;
	/** The package is on the bus: it sent a ready signal or a lifecycle event. */
	seen(via: "ready" | "event"): void;
}

/** A subagent extension that publishes lifecycle events on `pi.events`. */
export interface PackageSource {
	readonly package: SubagentPackage;
	/** Bus protocol version the package is expected to report on ping. */
	readonly protocolVersion: number;
	subscribe(pi: ExtensionAPI, sink: SourceSink, now: () => number): void;
	/** Send a ping and report the reply's protocol version. Returns an unsubscribe function. */
	ping(pi: ExtensionAPI, onReply: (version: number | undefined) => void): () => void;
}

export interface Detection {
	readonly status: SubagentSourceStatus;
	/** Keeps the first package and detection path; later signals only add the protocol version. */
	mark(source: PackageSource, via: "ping" | "ready" | "event", version?: number): void;
	/** Ping every package. With no reply within `timeoutMs`, the source is reported absent. */
	probe(pi: ExtensionAPI, timeoutMs: number, onAbsent: () => void): void;
	stop(): void;
}

export interface Instrumentation {
	handle(event: SourceEvent): void;
	/** End every open span. Unfinished runs are reported as errors of `errorType`. */
	shutdown(errorType: string): void;
	readonly dropped: number;
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

export interface SpanEnd {
	attributes?: SpanAttributes;
	error?: { type: string; message?: string };
	/** When the span ended, if earlier than now (events delivered late). */
	endTimeMs?: number;
}

export interface OpenSpan {
	record: SubagentTraceSpan;
	external?: TelemetrySpan;
	/** Resolves the telemetry callback, which ends the external span. */
	settle?: () => void;
}

export interface TracerOptions {
	telemetry?: TelemetryContext;
	now: () => number;
	/** Which attributes are recorded at all. Defaults to all. Rejected ones never reach memory, listeners or telemetry. */
	recordAttribute?: (key: string) => boolean;
	/**
	 * Which attributes a finished span keeps in memory. Defaults to all. Span-end listeners always
	 * receive every attribute; memory keeps only what this returns true for, so large content can go
	 * to disk without staying resident.
	 */
	retainAttribute?: (key: string) => boolean;
}

/**
 * Keyed span store, optionally mirrored into a pi-telemetry context. Knows nothing about subagents.
 * Open spans are held in full. A finished span is handed to listeners once, then kept as a summary
 * without the attributes `retainAttribute` rejects.
 */
export interface Tracer {
	readonly traceId: string;
	isOpen(key: string): boolean;
	openKeys(): string[];
	startTimeOf(key: string): number | undefined;
	/** No-op if `key` is already open. Without an open `parentKey`, the span is a root. */
	start(
		key: string,
		name: string,
		attributes: SpanAttributes,
		options?: { parentKey?: string; startTimeMs?: number },
	): void;
	addEvent(key: string, name: string, attributes?: SpanAttributes): void;
	end(key: string, info?: SpanEnd): void;
	/** Remove an open span from the local trace. An external copy cannot be withdrawn, so it gets `attributes`. */
	discard(key: string, attributes: SpanAttributes): void;
	/** Add attributes to an open span, e.g. facts learned after it started. No-op if `key` is not open. */
	setAttributes(key: string, attributes: SpanAttributes): void;
	/** Copies of all spans in start order, as summaries: rejected attributes are left out. */
	spans(): SubagentTraceSpan[];
	/**
	 * Called once per finished span with the full record. The record is shared between listeners and
	 * must not be mutated or retained; write it out instead.
	 */
	onSpanEnd(listener: (span: Readonly<SubagentTraceSpan>) => void): () => void;
}

// ---------------------------------------------------------------------------
// Exporters and fleet socket
// ---------------------------------------------------------------------------

export interface FleetServer {
	readonly path: string;
	close(): void;
}

/** One line of the trace file. */
export type TraceFileRecord =
	| { type: "span"; span: Readonly<SubagentTraceSpan> }
	/** Written at session start and shutdown. */
	| {
			type: "trace";
			traceId: string;
			source: SubagentSourceStatus;
			dropped: number;
			timeMs: number;
			/** The parent pi process. Spans without `process.pid` ran here. */
			process: { pid: number; hostname: string };
	  };

export interface TraceFile {
	readonly path: string;
	append(record: TraceFileRecord): void;
}
