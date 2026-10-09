import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { InMemoryTelemetryContext, type TelemetryContext } from "@earendil-works/pi-telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentOtelChild from "../child.ts";
import { traceFilePath } from "../file-exporter.ts";
import { createSubagentOtelExtension } from "../index.ts";
import { toOtlp } from "../otlp.ts";
import { renderTrace } from "../render.ts";
import {
	connectInProcess,
	FLEET_SOCKET_ENV,
	startFleetServer,
} from "../sources/fleet-ipc.ts";
import { createTracer } from "../tracer.ts";
import type {
	ConversationEvent,
	SourceEvent,
	SubagentOtelOptions,
	SubagentTrace,
	SubagentTraceSpan,
	TraceFileRecord,
} from "../types.ts";
import {
	createEventBus,
	discoverAndLoadExtensions,
	type ExtensionAPI,
	type ExtensionContext,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

/** A model registry with no network and no stored credentials, backed by files in `dir`. */
async function offlineModelRegistry(dir: string): Promise<ModelRegistry> {
	const runtime = await ModelRuntime.create({
		authPath: path.join(dir, "auth.json"),
		modelsPath: null,
		modelsStorePath: path.join(dir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	return new ModelRegistry(runtime);
}

/** Load extensions the way pi does, without your global extensions (agent dir is `dir`). */
const loadExtensions = (paths: string[], dir: string, bus: ReturnType<typeof createEventBus>) =>
	discoverAndLoadExtensions(paths, dir, dir, bus);

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(options: SubagentOtelOptions = {}, flags: Record<string, string> = {}, sessionFile?: string) {
	const events = createEventBus();
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	let clock = 1_000_000;
	const notify = vi.fn();
	const setStatus = vi.fn();
	const ctx = {
		cwd: process.cwd(),
		model: { provider: "openai", id: "gpt-5.5" },
		sessionManager: { getSessionId: () => "session-123", getSessionFile: () => sessionFile },
		hasUI: true,
		ui: { notify, setStatus },
	} as unknown as ExtensionContext;

	const api = {
		events,
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, command.handler);
		},
		registerFlag() {},
		getFlag(name: string) {
			return flags[name];
		},
	} as unknown as ExtensionAPI;

	createSubagentOtelExtension({ detectTimeoutMs: 5, now: () => clock, ...options })(api);

	const fire = async (event: string, payload: Record<string, unknown> = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
	};

	return {
		events,
		notify,
		setStatus,
		fire,
		advance(ms: number) {
			clock += ms;
		},
		async startSession() {
			await fire("session_start", { reason: "startup" });
		},
		async trace(): Promise<SubagentTrace> {
			const requestId = `req-${Math.random()}`;
			const reply = new Promise<SubagentTrace>((resolve) => {
				const unsubscribe = events.on(`subagent-otel:rpc:trace:reply:${requestId}`, (data) => {
					unsubscribe();
					resolve((data as { data: SubagentTrace }).data);
				});
			});
			events.emit("subagent-otel:rpc:trace", { requestId });
			return reply;
		},
		async runCommand(args = "") {
			await commands.get("subagent-trace")?.(args, ctx);
			return notify.mock.calls.at(-1)?.[0] as string;
		},
	};
}

/** Mirrors the ping handler @tintinweb/pi-subagents registers (async reply envelope). */
function installFakePiSubagents(events: ReturnType<typeof createEventBus>, version = 2) {
	events.on("subagents:rpc:ping", async (raw) => {
		const { requestId } = raw as { requestId: string };
		await Promise.resolve();
		events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version } });
	});
}

function spanNamed(trace: SubagentTrace, name: string): SubagentTraceSpan {
	const span = trace.spans.find((candidate) => candidate.name === name);
	if (!span) throw new Error(`no span ${name} in ${trace.spans.map((s) => s.name).join(", ")}`);
	return span;
}

describe("subagent-otel extension", () => {
	describe("when no subagent extension is installed", () => {
		it("reports the bus source as absent and an empty trace instead of failing", async () => {
			const t = setup();
			await t.startSession();
			await tick(20);

			const trace = await t.trace();
			expect(trace.source).toEqual({ state: "absent" });
			expect(trace.spans).toEqual([]);
			expect(await t.runCommand()).toContain("no subagent extension on the bus");
			expect(await t.runCommand()).toContain("no subagent invocations recorded");
		});

		it("shows the missing source in the footer and notifies once", async () => {
			const t = setup();
			await t.startSession();
			expect(t.setStatus).toHaveBeenLastCalledWith("subagent-otel", "otel: probing for subagent extensions");
			await tick(20);

			expect(t.setStatus).toHaveBeenLastCalledWith("subagent-otel", "otel: no subagent extension · 0 spans");
			const notices = t.notify.mock.calls.filter(([text]) => String(text).includes("no subagent extension found"));
			expect(notices).toHaveLength(1);

			await t.fire("tool_execution_start", { toolCallId: "c1", toolName: "subagent", args: { agent: "scout" } });
			await t.fire("tool_execution_end", { toolCallId: "c1", toolName: "subagent", isError: false, result: {} });
			expect(t.setStatus).toHaveBeenLastCalledWith("subagent-otel", "otel: no subagent extension · 1 span");
		});

		it("picks up pi-subagents when it announces itself later", async () => {
			const t = setup();
			await t.startSession();
			await tick(20);
			expect((await t.trace()).source.state).toBe("absent");

			t.events.emit("subagents:ready", {});
			t.events.emit("subagents:started", { id: "a1", type: "Explore", description: "find auth code" });
			t.events.emit("subagents:completed", { id: "a1", type: "Explore", status: "completed", durationMs: 10 });

			const trace = await t.trace();
			expect(trace.source).toEqual({
				state: "detected",
				package: "@tintinweb/pi-subagents",
				via: "ready",
				version: undefined,
			});
			expect(spanNamed(trace, "invoke_agent Explore").status.code).toBe("OK");
		});

		it("treats the first lifecycle event as detection when no ready signal was sent", async () => {
			const t = setup();
			await t.startSession();
			await tick(20);

			t.events.emit("subagents:started", { id: "a1", type: "Plan" });
			expect((await t.trace()).source).toMatchObject({ state: "detected", via: "event" });
		});
	});

	describe("@tintinweb/pi-subagents lifecycle mapping", () => {
		it("detects pi-subagents via ping and maps a run to an invoke_agent span", async () => {
			const t = setup();
			installFakePiSubagents(t.events);
			await t.startSession();
			await tick();

			t.events.emit("subagents:created", {
				id: "a1",
				type: "Explore",
				description: "find auth",
				isBackground: true,
			});
			t.advance(50);
			t.events.emit("subagents:started", { id: "a1", type: "Explore", description: "find auth" });
			t.advance(1200);
			t.events.emit("subagents:completed", {
				id: "a1",
				type: "Explore",
				description: "find auth",
				status: "completed",
				result: "SECRET RESULT TEXT",
				toolUses: 4,
				durationMs: 1200,
				tokens: { input: 100, output: 40, total: 140 },
				usage: { input: 100, output: 40, cacheRead: 900, cacheWrite: 10, cost: { total: 0.0123 } },
			});

			const trace = await t.trace();
			expect(trace.source).toEqual({
				state: "detected",
				package: "@tintinweb/pi-subagents",
				via: "ping",
				version: 2,
			});
			expect(t.setStatus).toHaveBeenLastCalledWith("subagent-otel", "otel: @tintinweb/pi-subagents v2 · 1 span");
			expect(t.notify).not.toHaveBeenCalled();

			const root = spanNamed(trace, "pi.session");
			expect(root.parentSpanId).toBeUndefined();
			expect(root.attributes["gen_ai.conversation.id"]).toBe("session-123");

			const span = spanNamed(trace, "invoke_agent Explore");
			expect(span.parentSpanId).toBe(root.spanId);
			expect(span.traceId).toBe(trace.traceId);
			expect(span.kind).toBe("INTERNAL");
			expect(span.endTimeMs! - span.startTimeMs).toBe(1200);
			expect(span.status).toEqual({ code: "OK" });
			expect(span.attributes).toMatchObject({
				"gen_ai.operation.name": "invoke_agent",
				"gen_ai.agent.name": "Explore",
				"gen_ai.agent.description": "find auth",
				// OTel input_tokens includes cached tokens.
				"gen_ai.usage.input_tokens": 1010,
				"gen_ai.usage.output_tokens": 40,
				"gen_ai.usage.cache_read.input_tokens": 900,
				"gen_ai.usage.cache_write.input_tokens": 10,
				"pi.usage.cost_usd": 0.0123,
				"pi.subagent.id": "a1",
				"pi.subagent.tool_uses": 4,
				"pi.subagent.background": true,
				"pi.subagent.queued_ms": 50,
			});
			// Transient ids are not stable agent ids, and results are never recorded.
			expect(span.attributes["gen_ai.agent.id"]).toBeUndefined();
			expect(JSON.stringify(trace)).not.toContain("SECRET RESULT TEXT");
		});

		it("falls back to the display token counts when usage is missing", async () => {
			const t = setup();
			t.events.emit("subagents:started", { id: "a1", type: "Explore" });
			t.events.emit("subagents:completed", {
				id: "a1",
				status: "completed",
				tokens: { input: 7, output: 3, total: 10 },
			});

			const span = spanNamed(await t.trace(), "invoke_agent Explore");
			expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(7);
			expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(3);
		});

		it("records failures with a low-cardinality error.type and the full message", async () => {
			const t = setup();
			t.events.emit("subagents:started", { id: "a1", type: "worker" });
			t.events.emit("subagents:failed", { id: "a1", status: "aborted", error: "x".repeat(500) });
			t.events.emit("subagents:started", { id: "a2", type: "worker" });
			t.events.emit("subagents:failed", { id: "a2", status: "exploded" });

			const [aborted, unknown] = (await t.trace()).spans.filter((span) => span.name === "invoke_agent worker");
			expect(aborted.status.code).toBe("ERROR");
			expect(aborted.attributes["error.type"]).toBe("aborted");
			expect(aborted.status.message).toBe("x".repeat(500));
			expect(unknown.attributes["error.type"]).toBe("_OTHER");
		});

		it("rebuilds a span for a completion whose start it never saw", async () => {
			const t = setup();
			t.events.emit("subagents:completed", { id: "late", type: "Plan", status: "completed", durationMs: 3000 });

			const span = spanNamed(await t.trace(), "invoke_agent Plan");
			expect(span.attributes["pi.subagent.orphan"]).toBe(true);
			expect(span.endTimeMs! - span.startTimeMs).toBe(3000);
		});

		it("drops payloads without an id and ignores duplicate starts", async () => {
			const t = setup();
			t.events.emit("subagents:started", null);
			t.events.emit("subagents:started", "not-an-object");
			t.events.emit("subagents:completed", { type: "Explore" });
			t.events.emit("subagents:started", { id: "" });
			t.events.emit("subagents:started", { id: "a1" });
			t.events.emit("subagents:started", { id: "a1" });

			const trace = await t.trace();
			expect(trace.dropped).toBe(4);
			expect(trace.spans.filter((span) => span.name === "invoke_agent")).toHaveLength(1);
			expect(spanNamed(trace, "invoke_agent").events.map((e) => e.name)).toEqual(["pi.subagent.duplicate_start"]);
			expect(renderTrace(trace)).toContain("4 malformed subagent event(s) dropped");
		});

		it("records steering and compaction as span events without message content", async () => {
			const t = setup();
			t.events.emit("subagents:started", { id: "a1", type: "worker" });
			t.events.emit("subagents:steered", { id: "a1", message: "PRIVATE STEER" });
			t.events.emit("subagents:compacted", {
				id: "a1",
				reason: "threshold",
				tokensBefore: 90000,
				compactionCount: 1,
			});
			t.events.emit("subagents:steered", { id: "unknown-agent", message: "ignored" });

			const span = spanNamed(await t.trace(), "invoke_agent worker");
			expect(span.events.map((e) => e.name)).toEqual(["pi.subagent.steered", "pi.subagent.compacted"]);
			expect(span.events[1].attributes).toEqual({
				"pi.compaction.reason": "threshold",
				"pi.compaction.tokens_before": 90000,
				"pi.compaction.count": 1,
			});
			expect(JSON.stringify(span)).not.toContain("PRIVATE STEER");
		});

		it("flags a protocol version mismatch but keeps tracing", async () => {
			const t = setup();
			installFakePiSubagents(t.events, 3);
			await t.startSession();
			await tick();
			t.events.emit("subagents:ready", {});

			const trace = await t.trace();
			expect(trace.source).toEqual({
				state: "incompatible",
				package: "@tintinweb/pi-subagents",
				via: "ping",
				version: 3,
			});
			expect(renderTrace(trace)).toContain("expected v2");
		});

		it("closes still-running subagents as errors on session shutdown", async () => {
			const t = setup();
			t.events.emit("subagents:started", { id: "a1", type: "worker" });
			await t.fire("session_shutdown", { reason: "quit" });

			const trace = await t.trace();
			expect(spanNamed(trace, "invoke_agent worker").attributes["error.type"]).toBe("pi.session_shutdown");
			expect(spanNamed(trace, "pi.session").status.code).toBe("OK");
			expect(trace.spans.every((span) => span.endTimeMs !== undefined)).toBe(true);
		});

		it("emits every finished span on the bus", async () => {
			const t = setup();
			const finished: string[] = [];
			t.events.on("subagent-otel:span", (span) => finished.push((span as SubagentTraceSpan).name));
			t.events.emit("subagents:started", { id: "a1", type: "Explore" });
			t.events.emit("subagents:completed", { id: "a1", status: "completed" });
			expect(finished).toEqual(["invoke_agent Explore"]);
		});
	});

	describe("bundled subagent tool fallback", () => {
		const usage = (input: number, output: number) => ({
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.001,
			contextTokens: 0,
			turns: 2,
		});

		it("maps a single-mode call to an invoke_agent span", async () => {
			const t = setup();
			await t.fire("tool_execution_start", {
				toolCallId: "c1",
				toolName: "subagent",
				args: { agent: "scout", task: "t" },
			});
			t.advance(800);
			await t.fire("tool_execution_end", {
				toolCallId: "c1",
				toolName: "subagent",
				isError: false,
				result: {
					details: {
						mode: "single",
						results: [
							{
								agent: "scout",
								task: "PRIVATE TASK",
								exitCode: 0,
								usage: usage(10, 5),
								model: "claude-haiku-4-5",
								stopReason: "stop",
							},
						],
					},
				},
			});

			const trace = await t.trace();
			const span = spanNamed(trace, "invoke_agent scout");
			expect(span.endTimeMs! - span.startTimeMs).toBe(800);
			expect(span.attributes).toMatchObject({
				"gen_ai.operation.name": "invoke_agent",
				"gen_ai.request.model": "claude-haiku-4-5",
				"gen_ai.response.finish_reasons": ["stop"],
				"gen_ai.usage.input_tokens": 10,
				"pi.subagent.source": "tool",
			});
			expect(JSON.stringify(trace)).not.toContain("PRIVATE TASK");
		});

		it("maps parallel mode to invoke_workflow with one child per agent", async () => {
			const t = setup();
			const tasks = [
				{ agent: "scout", task: "a" },
				{ agent: "reviewer", task: "b" },
			];
			await t.fire("tool_execution_start", { toolCallId: "c2", toolName: "subagent", args: { tasks } });
			t.advance(2000);
			await t.fire("tool_execution_end", {
				toolCallId: "c2",
				toolName: "subagent",
				isError: false,
				result: {
					details: {
						mode: "parallel",
						results: [
							{ agent: "scout", exitCode: 0, usage: usage(10, 5), stopReason: "stop" },
							{ agent: "reviewer", exitCode: 1, usage: usage(20, 0), stopReason: "error", errorMessage: "boom" },
						],
					},
				},
			});

			const trace = await t.trace();
			const workflow = spanNamed(trace, "invoke_workflow subagent.parallel");
			expect(workflow.attributes).toMatchObject({
				"gen_ai.operation.name": "invoke_workflow",
				"gen_ai.workflow.name": "subagent.parallel",
				"pi.subagent.count": 2,
				"pi.subagent.failed_count": 1,
				"gen_ai.usage.input_tokens": 30,
				"error.type": "subagent_failed",
			});
			const scout = spanNamed(trace, "invoke_agent scout");
			const reviewer = spanNamed(trace, "invoke_agent reviewer");
			expect(scout.parentSpanId).toBe(workflow.spanId);
			expect(reviewer.parentSpanId).toBe(workflow.spanId);
			expect(scout.status.code).toBe("OK");
			expect(reviewer.attributes["error.type"]).toBe("error");
			expect(reviewer.status.message).toBe("boom");

			const rendered = renderTrace(trace);
			expect(rendered).toContain("invoke_workflow subagent.parallel  2.0s  ERROR(subagent_failed)");
			expect(rendered).toContain("└─ invoke_agent reviewer");
		});

		it("closes the span when the tool result has an unexpected shape", async () => {
			const t = setup();
			await t.fire("tool_execution_start", { toolCallId: "c3", toolName: "subagent", args: { tasks: [] } });
			await t.fire("tool_execution_end", { toolCallId: "c3", toolName: "subagent", isError: true, result: "bad" });
			await t.fire("tool_execution_end", {
				toolCallId: "never-started",
				toolName: "subagent",
				isError: false,
				result: {},
			});
			await t.fire("tool_execution_start", { toolCallId: "c4", toolName: "bash", args: {} });

			const trace = await t.trace();
			expect(spanNamed(trace, "invoke_workflow subagent.parallel").attributes["error.type"]).toBe("tool_error");
			// The bash call and the never-started end add no run spans.
			expect(trace.spans.filter((span) => span.name.startsWith("invoke_"))).toHaveLength(1);
		});
	});

	describe("pi-telemetry forwarding", () => {
		it("mirrors the span tree into a telemetry context and settles each span", async () => {
			const telemetry = new InMemoryTelemetryContext();
			const t = setup({ telemetry });
			await t.startSession();
			t.events.emit("subagents:started", { id: "a1", type: "Explore" });
			t.events.emit("subagents:completed", { id: "a1", status: "completed", usage: { input: 5, output: 2 } });
			t.events.emit("subagents:started", { id: "a2", type: "worker" });
			t.events.emit("subagents:failed", { id: "a2", status: "error", error: "boom" });
			await t.fire("session_shutdown", { reason: "quit" });
			await tick();

			const spans = telemetry.getSpans();
			const root = spans.find((span) => span.name === "pi.session")!;
			const explore = spans.find((span) => span.name === "invoke_agent Explore")!;
			const worker = spans.find((span) => span.name === "invoke_agent worker")!;
			expect(spans.every((span) => span.settled)).toBe(true);
			expect(explore.parentId).toBe(root.id);
			expect(explore.attributes["gen_ai.usage.input_tokens"]).toBe(5);
			expect(explore.status).toEqual({ status: "ok" });
			expect(worker.status).toEqual({ status: "error", error: { name: "error", message: "boom" } });
		});

		it("keeps the local trace when the telemetry adapter throws", async () => {
			const broken: TelemetryContext = {
				startSpan() {
					throw new Error("adapter down");
				},
			};
			const t = setup({ telemetry: broken });
			t.events.emit("subagents:started", { id: "a1", type: "Explore" });
			t.events.emit("subagents:completed", { id: "a1", status: "completed" });

			expect(spanNamed(await t.trace(), "invoke_agent Explore").status.code).toBe("OK");
		});
	});
});

describe("subagent-otel extension loaded by pi", () => {
	const extensionPath = path.resolve(import.meta.dirname, "../index.ts");
	// Stand-in for @tintinweb/pi-subagents: same ping envelope, ready signal and lifecycle payloads.
	const fakePiSubagents = `
export default function (pi) {
	pi.events.on("subagents:rpc:ping", async ({ requestId }) => {
		await Promise.resolve();
		pi.events.emit("subagents:rpc:ping:reply:" + requestId, { success: true, data: { version: 2 } });
	});
	pi.on("session_start", () => pi.events.emit("subagents:ready", {}));
	pi.registerCommand("fake-spawn", {
		description: "spawn",
		handler: async () => {
			pi.events.emit("subagents:started", { id: "x1", type: "Explore", description: "scan" });
			pi.events.emit("subagents:completed", { id: "x1", type: "Explore", status: "completed", durationMs: 5, usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });
		},
	});
}
`;
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-otel-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function load(paths: string[]) {
		const bus = createEventBus();
		const result = await loadExtensions(paths, tempDir, bus);
		expect(result.errors).toEqual([]);
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir,
			SessionManager.inMemory(),
			await offlineModelRegistry(tempDir),
		);
		const trace = () =>
			new Promise<SubagentTrace>((resolve) => {
				const unsubscribe = bus.on("subagent-otel:rpc:trace:reply:r1", (reply) => {
					unsubscribe();
					resolve((reply as { data: SubagentTrace }).data);
				});
				bus.emit("subagent-otel:rpc:trace", { requestId: "r1" });
			});
		return { bus, runner, trace };
	}

	it("loads on its own and reports pi-subagents as absent", async () => {
		const { runner, trace } = await load([extensionPath]);
		await runner.emit({ type: "session_start", reason: "startup" });
		await tick(600);

		const result = await trace();
		expect(result.source.state).toBe("absent");
		expect(result.spans).toEqual([]);
	});

	it("traces lifecycle events from another loaded extension over the shared bus", async () => {
		const fakePath = path.join(tempDir, "fake-pi-subagents.ts");
		fs.writeFileSync(fakePath, fakePiSubagents);
		const { runner, trace } = await load([extensionPath, fakePath]);
		await runner.emit({ type: "session_start", reason: "startup" });
		await tick();
		await runner.getCommand("fake-spawn")?.handler("", runner.createCommandContext());

		const result = await trace();
		expect(result.source).toEqual({ state: "detected", package: "@tintinweb/pi-subagents", via: "ping", version: 2 });
		const span = spanNamed(result, "invoke_agent Explore");
		expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(3);
		expect(spanNamed(result, "pi.session").attributes["gen_ai.conversation.id"]).toEqual(expect.any(String));
	});

	it("traces the bundled subagent tool through runner tool events", async () => {
		const { runner, trace } = await load([extensionPath]);
		await runner.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "subagent",
			args: { agent: "scout" },
		});
		await runner.emit({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "subagent",
			isError: false,
			result: {
				details: { mode: "single", results: [{ agent: "scout", exitCode: 0, usage: { input: 1, output: 1 } }] },
			},
		});

		expect(spanNamed(await trace(), "invoke_agent scout").status.code).toBe("OK");
	});
});

describe("pi-subagents (nicobailon) mapping", () => {
	/** Mirrors the v1 RPC ping reply envelope pi-subagents 0.73 sends. */
	function installFakeV1(events: ReturnType<typeof createEventBus>, version = 1) {
		events.on("subagents:rpc:v1:request", async (raw) => {
			const { requestId, method } = raw as { requestId: string; method: string };
			await Promise.resolve();
			events.emit(`subagents:rpc:v1:reply:${requestId}`, {
				version: 1,
				requestId,
				method,
				success: true,
				data: { version, methods: ["ping"], events: { asyncComplete: "subagent:async-complete" } },
			});
		});
	}

	const usage = (input: number, output: number) => ({
		input,
		output,
		cacheRead: 5,
		cacheWrite: 0,
		cost: 0.01,
		turns: 3,
	});

	it("detects pi-subagents through its v1 ping", async () => {
		const t = setup();
		installFakeV1(t.events);
		await t.startSession();
		await tick(20);

		expect((await t.trace()).source).toEqual({ state: "detected", package: "pi-subagents", via: "ping", version: 1 });
		expect(t.setStatus).toHaveBeenLastCalledWith("subagent-otel", "otel: pi-subagents v1 · 0 spans");
		expect(t.notify).not.toHaveBeenCalled();
	});

	it("detects pi-subagents through its v1 ready signal", async () => {
		const t = setup();
		t.events.emit("subagents:rpc:v1:ready", { version: 1 });
		expect((await t.trace()).source).toMatchObject({ state: "detected", package: "pi-subagents", via: "ready" });
	});

	it("keeps a background run open from async-started until async-complete", async () => {
		const t = setup();
		t.events.emit("subagent:async-started", { id: "run-1", mode: "single", agent: "reviewer", task: "[redacted]" });
		t.advance(5000);
		expect((await t.trace()).spans.find((span) => span.name === "invoke_agent reviewer")?.endTimeMs).toBeUndefined();

		t.events.emit("subagent:async-complete", {
			id: "run-1",
			runId: "run-1",
			agent: "reviewer",
			mode: "single",
			state: "complete",
			success: true,
			summary: "PRIVATE SUMMARY",
			results: [
				{ agent: "reviewer", success: true, output: "PRIVATE OUTPUT", model: "gpt-5.5", usage: usage(100, 20) },
			],
		});

		const trace = await t.trace();
		const span = spanNamed(trace, "invoke_agent reviewer");
		expect(span.endTimeMs! - span.startTimeMs).toBe(5000);
		expect(span.status.code).toBe("OK");
		expect(span.attributes).toMatchObject({
			"gen_ai.operation.name": "invoke_agent",
			"gen_ai.request.model": "gpt-5.5",
			"gen_ai.usage.input_tokens": 105,
			"gen_ai.usage.output_tokens": 20,
			"pi.subagent.background": true,
			"pi.subagent.source": "pi-subagents",
			"pi.subagent.status": "complete",
		});
		expect(JSON.stringify(trace)).not.toMatch(/PRIVATE/);
		expect(trace.source).toMatchObject({ state: "detected", package: "pi-subagents", via: "event" });
	});

	it("maps failed and stopped background runs to errors", async () => {
		const t = setup();
		t.events.emit("subagent:async-started", { id: "r1", mode: "single", agent: "worker" });
		t.events.emit("subagent:async-complete", {
			runId: "r1",
			mode: "single",
			state: "failed",
			success: false,
			error: "boom",
		});
		t.events.emit("subagent:async-started", { id: "r2", mode: "single", agent: "worker" });
		t.events.emit("subagent:async-complete", {
			runId: "r2",
			mode: "single",
			state: "stopped",
			success: false,
			results: [{ agent: "worker", success: false, stopped: true }],
		});

		const [failed, stopped] = (await t.trace()).spans.filter((span) => span.name === "invoke_agent worker");
		expect(failed.attributes["error.type"]).toBe("failed");
		expect(failed.status.message).toBe("boom");
		expect(stopped.attributes["error.type"]).toBe("stopped");
	});

	it("maps a parallel background run to invoke_workflow with a child per agent", async () => {
		const t = setup();
		t.events.emit("subagent:async-started", { id: "p1", mode: "parallel", agents: ["scout", "reviewer"] });
		t.events.emit("subagent:async-complete", {
			runId: "p1",
			mode: "parallel",
			state: "complete",
			success: true,
			results: [
				{ agent: "scout", success: true, usage: usage(10, 1) },
				{ agent: "reviewer", success: false, error: "nope", usage: usage(20, 2) },
			],
		});

		const trace = await t.trace();
		const workflow = spanNamed(trace, "invoke_workflow subagent.parallel");
		expect(workflow.attributes).toMatchObject({ "pi.subagent.count": 2, "pi.subagent.failed_count": 1 });
		expect(workflow.attributes["error.type"]).toBe("subagent_failed");
		expect(spanNamed(trace, "invoke_agent reviewer").parentSpanId).toBe(workflow.spanId);
		expect(spanNamed(trace, "invoke_agent reviewer").status.message).toBe("nope");
	});

	it("rebuilds a completion whose async-started it never saw", async () => {
		const t = setup();
		t.events.emit("subagent:async-complete", {
			runId: "late",
			agent: "Plan",
			mode: "single",
			state: "complete",
			durationMs: 900,
		});

		const span = spanNamed(await t.trace(), "invoke_agent Plan");
		expect(span.attributes["pi.subagent.orphan"]).toBe(true);
		expect(span.endTimeMs! - span.startTimeMs).toBe(900);
	});

	it("drops the tool span of a background launch and traces the run from async events", async () => {
		const t = setup();
		await t.fire("tool_execution_start", {
			toolCallId: "c1",
			toolName: "subagent",
			args: { agent: "reviewer", task: "x" },
		});
		t.events.emit("subagent:async-started", { id: "run-9", mode: "single", agent: "reviewer" });
		await t.fire("tool_execution_end", {
			toolCallId: "c1",
			toolName: "subagent",
			isError: false,
			result: { details: { mode: "single", asyncId: "run-9", background: true, results: [] } },
		});
		t.events.emit("subagent:async-complete", { runId: "run-9", mode: "single", state: "complete", success: true });

		const trace = await t.trace();
		const runs = trace.spans.filter((span) => span.name.startsWith("invoke_agent"));
		expect(runs).toHaveLength(1);
		expect(runs[0].attributes["pi.subagent.id"]).toBe("run-9");
		// The launch stays visible as a tool call.
		expect(spanNamed(trace, "execute_tool subagent").status.code).toBe("OK");
	});

	it("does not trace management calls of the subagent tool", async () => {
		const t = setup();
		await t.fire("tool_execution_start", { toolCallId: "m1", toolName: "subagent", args: { action: "status" } });
		await t.fire("tool_execution_end", {
			toolCallId: "m1",
			toolName: "subagent",
			isError: false,
			result: { details: { mode: "management", results: [] } },
		});
		const trace = await t.trace();
		expect(trace.spans.filter((span) => span.name.startsWith("invoke_"))).toEqual([]);
		expect(spanNamed(trace, "execute_tool subagent").attributes["gen_ai.tool.call.id"]).toBe("m1");
	});

	it("reads pi-subagents foreground failures from the tool result", async () => {
		const t = setup();
		await t.fire("tool_execution_start", {
			toolCallId: "f1",
			toolName: "subagent",
			args: { agent: "worker", async: false },
		});
		await t.fire("tool_execution_end", {
			toolCallId: "f1",
			toolName: "subagent",
			isError: false,
			result: {
				details: {
					mode: "single",
					runId: "fg-1",
					results: [{ index: 0, agent: "worker", exitCode: 1, error: "tests failed", usage: usage(3, 1) }],
				},
			},
		});

		const span = spanNamed(await t.trace(), "invoke_agent worker");
		expect(span.attributes["error.type"]).toBe("nonzero_exit");
		expect(span.status.message).toBe("tests failed");
	});

	it("maps a workflow tool call to invoke_workflow", async () => {
		const t = setup();
		await t.fire("tool_execution_start", {
			toolCallId: "w1",
			toolName: "subagent",
			args: { workflowScript: "return 1" },
		});
		expect((await t.trace()).spans.map((span) => span.name)).toContain("invoke_workflow subagent.workflow");
	});
});

const installedPiSubagents = path.join(os.homedir(), ".pi/agent/npm/node_modules/pi-subagents/index.js");

describe.skipIf(!fs.existsSync(installedPiSubagents))("subagent-otel with the locally installed pi-subagents", () => {
	it("detects the real package over its v1 RPC", async () => {
		const bus = createEventBus();
		const extensionPath = path.resolve(import.meta.dirname, "../index.ts");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-otel-real-"));
		const result = await loadExtensions([installedPiSubagents, extensionPath], dir, bus);
		expect(result.errors).toEqual([]);
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			dir,
			SessionManager.inMemory(),
			await offlineModelRegistry(dir),
		);
		await runner.emit({ type: "session_start", reason: "startup" });
		await tick(1000);

		const trace = await new Promise<SubagentTrace>((resolve) => {
			bus.on("subagent-otel:rpc:trace:reply:real", (reply) => resolve((reply as { data: SubagentTrace }).data));
			bus.emit("subagent-otel:rpc:trace", { requestId: "real" });
		});
		expect(trace.source).toMatchObject({ state: "detected", package: "pi-subagents", version: 1 });
	});
});

function readTraceFile(filePath: string): TraceFileRecord[] {
	return fs
		.readFileSync(filePath, "utf-8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as TraceFileRecord);
}

const spanRecords = (records: TraceFileRecord[]) =>
	records.flatMap((record) => (record.type === "span" ? [record.span] : []));

describe("file exporter", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-otel-file-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("appends one line per finished span to a dated file named from the CLI flags", async () => {
		const t = setup({}, { "subagent-otel-name": "explore", "subagent-otel-dir": tempDir });
		await t.startSession();
		const outputPath = traceFilePath(tempDir, "explore", 1_000_000);
		expect(outputPath.endsWith(".jsonl")).toBe(true);
		expect(t.notify).toHaveBeenCalledWith(`subagent-otel: writing trace to ${outputPath}`, "info");

		t.events.emit("subagents:started", { id: "a1", type: "Explore" });
		t.events.emit("subagents:completed", { id: "a1", status: "completed", durationMs: 10 });
		expect(spanRecords(readTraceFile(outputPath)).map((span) => span.name)).toEqual(["invoke_agent Explore"]);
		expect((await t.trace()).file).toBe(outputPath);
		await t.fire("session_shutdown", { reason: "quit" });

		const records = readTraceFile(outputPath);
		expect(records.map((record) => record.type)).toEqual(["trace", "span", "span", "trace"]);
		expect(spanRecords(records).map((span) => span.name)).toEqual(["invoke_agent Explore", "pi.session"]);
	});

	it("writes next to the session file by default", async () => {
		const sessionFile = path.join(tempDir, "2026-10-08T21-48-19_abc.jsonl");
		const t = setup({}, {}, sessionFile);
		await t.startSession();
		expect(t.notify).toHaveBeenCalledWith(
			`subagent-otel: writing trace to ${path.join(tempDir, "2026-10-08T21-48-19_abc.otel.jsonl")}`,
			"info",
		);
	});

	it("writes nothing for an in-memory session or with --subagent-otel-exporter none", async () => {
		await setup().startSession();
		await setup({}, { "subagent-otel-exporter": "none" }, path.join(tempDir, "s.jsonl")).startSession();
		expect(fs.readdirSync(tempDir)).toEqual([]);
	});

	it("keeps a slash in the name inside the trace directory", async () => {
		const t = setup({}, { "subagent-otel-name": "../explore/run", "subagent-otel-dir": tempDir });
		await t.startSession();
		const outputPath = traceFilePath(tempDir, "../explore/run", 1_000_000);
		expect(path.dirname(outputPath)).toBe(tempDir);
		expect(fs.existsSync(outputPath)).toBe(true);
	});

	it("reports an unknown exporter and writes nothing", async () => {
		const t = setup({}, { "subagent-otel-exporter": "otlp", "subagent-otel-dir": tempDir });
		await t.startSession();
		expect(t.notify).toHaveBeenCalledWith('subagent-otel: unknown exporter "otlp" (supported: file, none)', "error");
		expect(fs.readdirSync(tempDir)).toEqual([]);
	});
});

describe("parent conversation", () => {
	const system = { role: "system", content: "You are pi.", timestamp: 1 };
	const user = { role: "user", content: "what is the weather", timestamp: 2 };
	const assistant = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "need curl" },
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "curl wttr.in" } },
		],
		provider: "openai",
		model: "gpt-5.5",
		responseId: "resp_1",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
		stopReason: "toolUse",
		timestamp: 3,
	};

	async function runPrompt(t: ReturnType<typeof setup>) {
		await t.fire("agent_start");
		await t.fire("context_with_system", { messages: [system, user] });
		t.advance(400);
		await t.fire("message_end", { message: assistant });
		await t.fire("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "curl wttr.in" } });
		await t.fire("tool_execution_end", {
			toolCallId: "t1",
			toolName: "bash",
			isError: false,
			result: { content: [{ type: "text", text: "Sunny 24C" }] },
		});
		await t.fire("agent_end", { messages: [user, assistant] });
	}

	it("maps a prompt to invoke_agent pi with chat and execute_tool children", async () => {
		const t = setup();
		await runPrompt(t);

		const trace = await t.trace();
		const agent = spanNamed(trace, "invoke_agent pi");
		const chat = spanNamed(trace, "chat gpt-5.5");
		const tool = spanNamed(trace, "execute_tool bash");
		expect(chat.parentSpanId).toBe(agent.spanId);
		expect(tool.parentSpanId).toBe(agent.spanId);
		expect(chat.endTimeMs! - chat.startTimeMs).toBe(400);
		expect(chat.attributes).toMatchObject({
			"gen_ai.operation.name": "chat",
			"gen_ai.provider.name": "openai",
			"gen_ai.request.model": "gpt-5.5",
			"gen_ai.response.id": "resp_1",
			"gen_ai.response.finish_reasons": ["toolUse"],
			"gen_ai.usage.input_tokens": 10,
		});
		expect(tool.attributes).toMatchObject({ "gen_ai.tool.name": "bash", "gen_ai.tool.call.id": "t1" });
		// Content is not kept in memory.
		expect(JSON.stringify(trace)).not.toContain("what is the weather");
		expect(JSON.stringify(trace)).not.toContain("Sunny 24C");
	});

	it("records full content on the finished spans with --subagent-otel-content full", async () => {
		const t = setup({}, { "subagent-otel-content": "full" });
		const finished: SubagentTraceSpan[] = [];
		t.events.on("subagent-otel:span", (span) => finished.push(structuredClone(span as SubagentTraceSpan)));
		await t.startSession();
		await runPrompt(t);

		const byName = (name: string) => finished.find((span) => span.name === name)!;
		const chat = byName("chat gpt-5.5").attributes;
		expect(JSON.parse(chat["gen_ai.system_instructions"] as string)).toEqual([
			{ type: "text", content: "You are pi." },
		]);
		expect(JSON.parse(chat["gen_ai.input.messages"] as string)).toEqual([
			{ role: "user", parts: [{ type: "text", content: "what is the weather" }] },
		]);
		expect(JSON.parse(chat["gen_ai.output.messages"] as string)).toEqual([
			{
				role: "assistant",
				finish_reason: "toolUse",
				parts: [
					{ type: "reasoning", content: "need curl" },
					{ type: "tool_call", id: "t1", name: "bash", arguments: { command: "curl wttr.in" } },
				],
			},
		]);
		const tool = byName("execute_tool bash").attributes;
		expect(JSON.parse(tool["gen_ai.tool.call.arguments"] as string)).toEqual({ command: "curl wttr.in" });
		expect(tool["gen_ai.tool.call.result"]).toContain("Sunny 24C");
		expect(byName("invoke_agent pi").attributes["gen_ai.input.messages"]).toContain("what is the weather");
	});

	it("records no content by default", async () => {
		const t = setup();
		const finished: SubagentTraceSpan[] = [];
		t.events.on("subagent-otel:span", (span) => finished.push(structuredClone(span as SubagentTraceSpan)));
		await t.startSession();
		await runPrompt(t);

		const all = JSON.stringify(finished);
		for (const text of ["what is the weather", "need curl", "curl wttr.in", "Sunny 24C", "You are pi."]) {
			expect(all).not.toContain(text);
		}
		// Structure, models and usage are still there.
		const chat = finished.find((span) => span.name === "chat gpt-5.5")!;
		expect(chat.attributes).toMatchObject({ "gen_ai.request.model": "gpt-5.5", "gen_ai.usage.input_tokens": 10 });
		expect(finished.find((span) => span.name === "execute_tool bash")!.attributes["gen_ai.tool.call.id"]).toBe("t1");
	});

	it("reports an unknown content mode and records no content", async () => {
		const t = setup({}, { "subagent-otel-content": "some" });
		await t.startSession();
		expect(t.notify).toHaveBeenCalledWith(
			'subagent-otel: unknown --subagent-otel-content "some" (supported: none, full); recording no content',
			"error",
		);
	});

	it("nests a foreground subagent run under its execute_tool subagent span", async () => {
		const t = setup();
		await t.fire("agent_start");
		await t.fire("tool_execution_start", {
			toolCallId: "c1",
			toolName: "subagent",
			args: { agent: "scout", task: "find the auth code" },
		});
		await t.fire("tool_execution_end", {
			toolCallId: "c1",
			toolName: "subagent",
			isError: false,
			result: { details: { mode: "single", results: [{ agent: "scout", exitCode: 0, output: "found it" }] } },
		});

		const trace = await t.trace();
		const run = spanNamed(trace, "invoke_agent scout");
		expect(run.parentSpanId).toBe(spanNamed(trace, "execute_tool subagent").spanId);
		expect(run.attributes["pi.subagent.launch_tool_call_id"]).toBe("c1");
	});
});

describe("tracer", () => {
	const isContent = (key: string) => key.startsWith("content.");

	it("hands listeners the full span once and keeps a summary without content", () => {
		const tracer = createTracer({ now: () => 1000, retainAttribute: (key) => !isContent(key) });
		const received: SubagentTraceSpan[] = [];
		tracer.onSpanEnd((span) => received.push(structuredClone(span)));

		tracer.start("a", "chat", { model: "m", "content.input": "PROMPT" });
		tracer.addEvent("a", "note", { kind: "k", "content.text": "EVENT TEXT" });
		expect(JSON.stringify(tracer.spans())).not.toContain("PROMPT");
		tracer.end("a", { attributes: { "content.output": "ANSWER", tokens: 3 } });

		expect(received).toHaveLength(1);
		expect(received[0].attributes).toMatchObject({
			"content.input": "PROMPT",
			"content.output": "ANSWER",
			tokens: 3,
		});
		expect(received[0].events[0].attributes["content.text"]).toBe("EVENT TEXT");

		const [summary] = tracer.spans();
		expect(summary.attributes).toEqual({ model: "m", tokens: 3 });
		expect(summary.events[0].attributes).toEqual({ kind: "k" });
		expect(summary.status.code).toBe("OK");
	});

	it("keeps every attribute when no retention rule is given", () => {
		const tracer = createTracer({ now: () => 1000 });
		tracer.start("a", "chat", { "content.input": "PROMPT" });
		tracer.end("a");
		expect(tracer.spans()[0].attributes["content.input"]).toBe("PROMPT");
	});

	it("keeps start order and drops discarded spans", () => {
		const tracer = createTracer({ now: () => 1000 });
		tracer.start("a", "first", {});
		tracer.start("b", "second", {}, { parentKey: "a" });
		tracer.start("c", "third", {});
		tracer.end("b");
		tracer.discard("c", {});
		const spans = tracer.spans();
		expect(spans.map((span) => span.name)).toEqual(["first", "second"]);
		expect(spans[1].parentSpanId).toBe(spans[0].spanId);
	});
});

describe("fleet: child conversations over the socket", () => {
	const user = { role: "user", content: "find the weather", timestamp: 1 };
	const reply = {
		role: "assistant",
		content: [{ type: "toolCall", id: "k1", name: "contact_supervisor", arguments: { message: "which city?" } }],
		model: "gpt-5.5",
		usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0 },
		stopReason: "toolUse",
	};
	const turn: ConversationEvent[] = [
		{ kind: "llm.start", callKey: "1", model: "gpt-5.5", provider: "openai", messages: [user], timeMs: 1000 },
		{ kind: "llm.end", callKey: "1", output: reply, usage: reply.usage, stopReason: "toolUse", timeMs: 1500 },
		{
			kind: "tool.start",
			toolCallId: "k1",
			toolName: "contact_supervisor",
			arguments: { message: "which city?" },
			timeMs: 1500,
		},
		{
			kind: "tool.end",
			toolCallId: "k1",
			result: { content: [{ type: "text", text: "Kew Gardens" }] },
			isError: false,
			timeMs: 2600,
		},
	];

	async function connectChild(hello: { sessionId: string; sessionFile?: string }) {
		const socket = net.createConnection(process.env[FLEET_SOCKET_ENV]!);
		await once(socket, "connect");
		const write = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
		write({ v: 1, type: "hello", pid: 1, ...hello });
		return {
			write,
			async send(events: ConversationEvent[]) {
				for (const event of events) write({ v: 1, type: "event", event });
				await tick(30);
			},
			close: () => socket.end(),
		};
	}

	it("nests an async child's turns under its run, matched by session root", async () => {
		const t = setup();
		await t.startSession();
		t.events.emit("subagent:async-started", {
			id: "r1",
			mode: "single",
			agent: "researcher",
			sessionRoot: "/s/fe26",
		});
		const child = await connectChild({ sessionId: "c1", sessionFile: "/s/fe26/run-0/session.jsonl" });
		await child.send(turn);
		child.close();

		const trace = await t.trace();
		const run = spanNamed(trace, "invoke_agent researcher");
		const chat = spanNamed(trace, "chat gpt-5.5");
		const tool = spanNamed(trace, "execute_tool contact_supervisor");
		expect(chat.parentSpanId).toBe(run.spanId);
		expect(tool.parentSpanId).toBe(run.spanId);
		// Child timestamps, not arrival time.
		expect([chat.startTimeMs, chat.endTimeMs]).toEqual([1000, 1500]);
		expect(tool.endTimeMs! - tool.startTimeMs).toBe(1100);
		expect(chat.attributes["gen_ai.usage.input_tokens"]).toBe(7);
		// Process boundary: the child (pid 1) is not this process.
		expect(chat.attributes["process.pid"]).toBe(1);
		expect(run.attributes).toMatchObject({
			"pi.subagent.execution": "separate_process",
			"pi.subagent.process.pid": 1,
		});
	});

	it("buffers a child that connects before its run starts", async () => {
		const t = setup();
		await t.startSession();
		const child = await connectChild({ sessionId: "c1", sessionFile: "/s/early/run-0/session.jsonl" });
		await child.send(turn.slice(0, 2));
		expect((await t.trace()).spans.some((span) => span.name === "chat gpt-5.5")).toBe(false);

		t.events.emit("subagent:async-started", {
			id: "r1",
			mode: "single",
			agent: "researcher",
			sessionRoot: "/s/early",
		});
		const trace = await t.trace();
		expect(spanNamed(trace, "chat gpt-5.5").parentSpanId).toBe(spanNamed(trace, "invoke_agent researcher").spanId);
	});

	it("puts each workflow child under its own invoke_agent span", async () => {
		const t = setup();
		await t.startSession();
		t.events.emit("subagent:async-started", {
			id: "p1",
			mode: "parallel",
			agents: ["scout", "reviewer"],
			sessionRoot: "/s/p1",
		});
		const reviewer = await connectChild({ sessionId: "c2", sessionFile: "/s/p1/run-1/session.jsonl" });
		await reviewer.send(turn.slice(0, 2));
		t.events.emit("subagent:async-complete", {
			runId: "p1",
			mode: "parallel",
			state: "complete",
			results: [
				{ agent: "scout", success: true },
				{ agent: "reviewer", success: true, output: "looks good" },
			],
		});

		const trace = await t.trace();
		const workflow = spanNamed(trace, "invoke_workflow subagent.parallel");
		const reviewerSpan = spanNamed(trace, "invoke_agent reviewer");
		expect(reviewerSpan.parentSpanId).toBe(workflow.spanId);
		expect(reviewerSpan.status.code).toBe("OK");
		expect(spanNamed(trace, "chat gpt-5.5").parentSpanId).toBe(reviewerSpan.spanId);
		expect(trace.spans.filter((span) => span.name === "invoke_agent reviewer")).toHaveLength(1);
	});

	it("matches a foreground child to the only open subagent call", async () => {
		const t = setup();
		await t.startSession();
		await t.fire("tool_execution_start", { toolCallId: "f1", toolName: "subagent", args: { agent: "scout" } });
		const child = await connectChild({ sessionId: "c1", sessionFile: "/fg/abc/run-0/session.jsonl" });
		await child.send(turn.slice(0, 2));

		const trace = await t.trace();
		expect(spanNamed(trace, "chat gpt-5.5").parentSpanId).toBe(spanNamed(trace, "invoke_agent scout").spanId);
	});

	it("attributes an in-process child whose call ends right after its last event", async () => {
		// Regression: over the socket, a fast foreground child's events arrived after the tool call ended.
		const t = setup();
		await t.startSession();
		await t.fire("tool_execution_start", { toolCallId: "f1", toolName: "researcher-call", args: {} });
		await t.fire("tool_execution_start", { toolCallId: "f2", toolName: "subagent", args: { agent: "researcher" } });
		const send = connectInProcess(process.env[FLEET_SOCKET_ENV]!)!;
		send({ v: 1, type: "hello", sessionId: "c1", sessionFile: "/fg/7950/run-0/session.jsonl", pid: process.pid });
		for (const event of turn.slice(0, 2)) send({ v: 1, type: "event", event });
		await t.fire("tool_execution_end", { toolCallId: "f2", toolName: "subagent", isError: true, result: "failed" });

		const trace = await t.trace();
		expect(spanNamed(trace, "chat gpt-5.5").parentSpanId).toBe(spanNamed(trace, "invoke_agent researcher").spanId);
		expect(trace.spans.some((span) => span.attributes["pi.subagent.unattributed"])).toBe(false);
		expect(spanNamed(trace, "invoke_agent researcher").attributes["pi.subagent.execution"]).toBe("in_process");
	});

	it("waits for the result rows when several subagent calls are open", async () => {
		const t = setup();
		await t.startSession();
		await t.fire("tool_execution_start", { toolCallId: "f1", toolName: "subagent", args: { agent: "scout" } });
		await t.fire("tool_execution_start", { toolCallId: "f2", toolName: "subagent", args: { agent: "planner" } });
		const child = await connectChild({ sessionId: "c1", sessionFile: "/fg/two/run-0/session.jsonl" });
		await child.send(turn.slice(0, 2));
		expect((await t.trace()).spans.some((span) => span.name === "chat gpt-5.5")).toBe(false);

		await t.fire("tool_execution_end", {
			toolCallId: "f2",
			toolName: "subagent",
			isError: false,
			result: {
				details: {
					mode: "single",
					results: [{ agent: "planner", exitCode: 0, sessionFile: "/fg/two/run-0/session.jsonl" }],
				},
			},
		});
		const trace = await t.trace();
		expect(spanNamed(trace, "chat gpt-5.5").parentSpanId).toBe(spanNamed(trace, "invoke_agent planner").spanId);
	});

	it("keeps an unmatched child under the root at shutdown, marked unattributed", async () => {
		const t = setup({}, { "subagent-otel-content": "full" });
		const finished: SubagentTraceSpan[] = [];
		t.events.on("subagent-otel:span", (span) => finished.push(structuredClone(span as SubagentTraceSpan)));
		await t.startSession();
		const child = await connectChild({ sessionId: "c9", sessionFile: "/nowhere/run-0/session.jsonl" });
		await child.send(turn.slice(0, 2));
		await t.fire("session_shutdown", { reason: "quit" });

		const chat = finished.find((span) => span.name === "chat gpt-5.5")!;
		expect(chat.parentSpanId).toBe(finished.find((span) => span.name === "pi.session")!.spanId);
		expect(chat.attributes).toMatchObject({
			"pi.subagent.unattributed": true,
			"pi.subagent.session_file": "/nowhere/run-0/session.jsonl",
		});
		expect(chat.attributes["gen_ai.input.messages"]).toContain("find the weather");
	});

	it("counts malformed lines and events sent before hello", async () => {
		const t = setup();
		await t.startSession();
		const socket = net.createConnection(process.env[FLEET_SOCKET_ENV]!);
		await once(socket, "connect");
		socket.write("not json\n");
		socket.write(`${JSON.stringify({ v: 1, type: "event", event: turn[0] })}\n`);
		socket.write(`${JSON.stringify({ v: 2, type: "hello" })}\n`);
		await tick(30);
		socket.end();
		expect((await t.trace()).dropped).toBe(3);
	});

	it("publishes the socket path and registers child.ts for the session's children", async () => {
		const t = setup();
		await t.startSession();
		const registry = (globalThis as Record<symbol, unknown>)[
			Symbol.for("pi-subagents.required-child-extensions.v1")
		] as { bySession: Map<string, { id: string; path: string }[]> };
		const entry = registry.bySession.get("session-123")!;
		expect(entry.map((extension) => extension.id)).toEqual(["subagent-otel"]);
		expect(entry[0].path.endsWith(path.join("subagent-otel", "child.ts"))).toBe(true);
		expect(process.env[FLEET_SOCKET_ENV]).toBeTruthy();

		await t.fire("session_shutdown", { reason: "quit" });
		expect(registry.bySession.has("session-123")).toBe(false);
		expect(process.env[FLEET_SOCKET_ENV]).toBeUndefined();
	});
});

describe("fleet: child.ts", () => {
	it("streams the child's conversation to the parent socket", async () => {
		const received: SourceEvent[] = [];
		const server = startFleetServer((event) => received.push(event));
		const previous = process.env[FLEET_SOCKET_ENV];
		process.env[FLEET_SOCKET_ENV] = server.path;
		try {
			const handlers = new Map<string, Handler[]>();
			const api = {
				on(event: string, handler: Handler) {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
			} as unknown as ExtensionAPI;
			subagentOtelChild(api);
			const ctx = {
				model: { provider: "openai", id: "gpt-5.5" },
				sessionManager: { getSessionId: () => "child-1", getSessionFile: () => "/s/r/run-0/session.jsonl" },
			} as unknown as ExtensionContext;
			const fire = async (event: string, payload: Record<string, unknown> = {}) => {
				for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
			};
			await fire("session_start");
			await fire("context_with_system", { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
			await fire("tool_execution_start", { toolCallId: "t1", toolName: "read", args: { path: "a" } });
			await fire("session_shutdown");
			await tick(50);

			expect(received.map((event) => (event.kind === "conversation" ? event.event.kind : event.kind))).toEqual([
				"llm.start",
				"tool.start",
			]);
			const [first] = received;
			expect(first).toMatchObject({
				kind: "conversation",
				scope: { kind: "child", sessionId: "child-1", sessionFile: "/s/r/run-0/session.jsonl" },
				event: { kind: "llm.start", model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] },
			});
			expect(first.kind === "conversation" && typeof first.event.timeMs).toBe("number");
		} finally {
			server.close();
			if (previous === undefined) delete process.env[FLEET_SOCKET_ENV];
			else process.env[FLEET_SOCKET_ENV] = previous;
		}
	});

	it("uses the socket when the parent is in another process", async () => {
		const received: SourceEvent[] = [];
		const server = startFleetServer((event) => received.push(event));
		// Simulate an async runner: no in-process server for this path.
		(globalThis as Record<symbol, Map<string, unknown>>)[Symbol.for("subagent-otel.fleet-in-process.v1")].delete(
			server.path,
		);
		const previous = process.env[FLEET_SOCKET_ENV];
		process.env[FLEET_SOCKET_ENV] = server.path;
		try {
			const handlers = new Map<string, Handler[]>();
			subagentOtelChild({
				on(event: string, handler: Handler) {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
			} as unknown as ExtensionAPI);
			const ctx = {
				sessionManager: { getSessionId: () => "child-2", getSessionFile: () => undefined },
			} as unknown as ExtensionContext;
			for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
			for (const handler of handlers.get("tool_execution_start") ?? []) {
				await handler({ type: "tool_execution_start", toolCallId: "t1", toolName: "ls", args: {} }, ctx);
			}
			expect(received).toEqual([]);
			await tick(50);
			expect(received).toMatchObject([
				{ kind: "conversation", scope: { sessionId: "child-2" }, event: { kind: "tool.start", toolName: "ls" } },
			]);
		} finally {
			server.close();
			if (previous === undefined) delete process.env[FLEET_SOCKET_ENV];
			else process.env[FLEET_SOCKET_ENV] = previous;
		}
	});

	it("stays inert without a socket path", () => {
		const previous = process.env[FLEET_SOCKET_ENV];
		delete process.env[FLEET_SOCKET_ENV];
		const on = vi.fn();
		subagentOtelChild({ on } as unknown as ExtensionAPI);
		expect(on).not.toHaveBeenCalled();
		if (previous !== undefined) process.env[FLEET_SOCKET_ENV] = previous;
	});
});

describe("OTLP conversion", () => {
	const span = (overrides: Partial<SubagentTraceSpan>): SubagentTraceSpan => ({
		traceId: "a".repeat(32),
		spanId: "0".repeat(16),
		name: "span",
		kind: "INTERNAL",
		startTimeMs: 1000,
		endTimeMs: 2500.5,
		attributes: {},
		events: [],
		status: { code: "OK" },
		...overrides,
	});
	const records: TraceFileRecord[] = [
		span({ spanId: "1".repeat(16), name: "pi.session" }),
		span({ spanId: "2".repeat(16), parentSpanId: "1".repeat(16), name: "invoke_agent pi" }),
		span({
			spanId: "3".repeat(16),
			parentSpanId: "2".repeat(16),
			name: "execute_tool subagent",
			attributes: {
				"gen_ai.tool.name": "subagent",
				"gen_ai.tool.call.id": "call-async",
				"gen_ai.tool.call.result": JSON.stringify({ details: { asyncId: "run-1" } }),
			},
		}),
		span({
			spanId: "4".repeat(16),
			parentSpanId: "2".repeat(16),
			name: "invoke_agent delegate",
			attributes: {
				"gen_ai.operation.name": "invoke_agent",
				"gen_ai.agent.name": "delegate",
				"pi.subagent.id": "run-1",
				"pi.subagent.source": "pi-subagents",
				"pi.subagent.background": true,
				"pi.usage.cost_usd": 0.25,
				"gen_ai.response.finish_reasons": ["stop"],
			},
		}),
		span({
			spanId: "5".repeat(16),
			parentSpanId: "4".repeat(16),
			name: "chat gpt-5.5",
			attributes: { "gen_ai.usage.input_tokens": 12 },
			events: [{ name: "note", timeMs: 1200, attributes: {} }],
			status: { code: "ERROR", message: "aborted" },
		}),
	].map((value) => ({ type: "span" as const, span: value }));

	it("splits spans into a parent service and one service per subagent conversation", () => {
		const request = toOtlp(records);
		const services = Object.fromEntries(
			request.resourceSpans.map((resource) => [
				(resource.resource.attributes[0].value as { stringValue: string }).stringValue,
				resource.scopeSpans[0].spans.map((value) => value.name),
			]),
		);
		expect(services).toEqual({
			pi: ["pi.session", "invoke_agent pi", "execute_tool subagent", "invoke_agent delegate"],
			"pi-subagent:delegate": ["chat gpt-5.5"],
		});
	});

	it("keeps ids, parents, exact times, typed attributes, events and status", () => {
		const spans = toOtlp(records).resourceSpans.flatMap((resource) => resource.scopeSpans[0].spans);
		const chat = spans.find((value) => value.name === "chat gpt-5.5")!;
		expect(chat).toMatchObject({
			traceId: "a".repeat(32),
			spanId: "5".repeat(16),
			parentSpanId: "4".repeat(16),
			kind: 1,
			startTimeUnixNano: "1000000000",
			endTimeUnixNano: "2500500000",
			attributes: [{ key: "gen_ai.usage.input_tokens", value: { intValue: "12" } }],
			events: [{ name: "note", timeUnixNano: "1200000000", attributes: [] }],
			status: { code: 2, message: "aborted" },
		});
		const run = spans.find((value) => value.name === "invoke_agent delegate")!;
		expect(run.attributes).toEqual(
			expect.arrayContaining([
				{ key: "pi.subagent.background", value: { boolValue: true } },
				{ key: "pi.usage.cost_usd", value: { doubleValue: 0.25 } },
				{ key: "gen_ai.response.finish_reasons", value: { arrayValue: { values: [{ stringValue: "stop" }] } } },
			]),
		);
		expect(spans.find((value) => value.name === "pi.session")!.parentSpanId).toBeUndefined();
	});

	it("links an async run to the tool call that launched it", () => {
		const spans = toOtlp(records).resourceSpans.flatMap((resource) => resource.scopeSpans[0].spans);
		expect(spans.find((value) => value.name === "invoke_agent delegate")!.links).toEqual([
			{
				traceId: "a".repeat(32),
				spanId: "3".repeat(16),
				attributes: [{ key: "pi.link.type", value: { stringValue: "launched_by" } }],
			},
		]);
		expect(spans.find((value) => value.name === "chat gpt-5.5")!.links).toEqual([]);
	});
});

describe("OTLP conversion: process boundary and content events", () => {
	const traceRecord: TraceFileRecord = {
		type: "trace",
		traceId: "b".repeat(32),
		source: { state: "detected" },
		dropped: 0,
		timeMs: 0,
		process: { pid: 100, hostname: "box" },
	};
	const base = { traceId: "b".repeat(32), kind: "INTERNAL" as const, events: [], status: { code: "OK" as const } };
	const records: TraceFileRecord[] = [
		traceRecord,
		{
			type: "span",
			span: {
				...base,
				spanId: "1".repeat(16),
				name: "invoke_agent delegate",
				startTimeMs: 0,
				endTimeMs: 10,
				attributes: {
					"gen_ai.operation.name": "invoke_agent",
					"gen_ai.agent.name": "delegate",
					"pi.subagent.source": "pi-subagents",
					"pi.subagent.execution": "separate_process",
				},
			},
		},
		{
			type: "span",
			span: {
				...base,
				spanId: "2".repeat(16),
				parentSpanId: "1".repeat(16),
				name: "chat gpt-5.5",
				startTimeMs: 1,
				endTimeMs: 5,
				attributes: {
					"gen_ai.operation.name": "chat",
					"process.pid": 200,
					"gen_ai.input.messages": JSON.stringify([
						{ role: "user", parts: [{ type: "text", content: "old prompt" }] },
						{ role: "assistant", parts: [{ type: "text", content: "old answer" }] },
						{ role: "tool", parts: [{ type: "tool_call_response", id: "t1", response: "ls output" }] },
					]),
					"gen_ai.output.messages": JSON.stringify([
						{
							role: "assistant",
							parts: [
								{ type: "reasoning", content: "**Plan** read the file" },
								{ type: "tool_call", id: "t2", name: "read", arguments: { path: "a" } },
							],
						},
					]),
				},
			},
		},
	];

	it("puts each process in its own resource and marks cross-process runs CLIENT", () => {
		const request = toOtlp(records);
		const resources = request.resourceSpans.map((resource) =>
			Object.fromEntries(resource.resource.attributes.map((kv) => [kv.key, Object.values(kv.value)[0]])),
		);
		expect(resources).toEqual([
			{ "service.name": "pi", "process.pid": "100", "host.name": "box", "pi.process.role": "main" },
			{
				"service.name": "pi-subagent:delegate",
				"process.pid": "200",
				"host.name": "box",
				"pi.process.role": "subagent_runner",
			},
		]);
		expect(request.resourceSpans[0].scopeSpans[0].spans[0].kind).toBe(3);
		expect(request.resourceSpans[1].scopeSpans[0].spans[0].kind).toBe(1);
	});

	it("adds the new input and every output part of a chat span as events", () => {
		const chat = toOtlp(records).resourceSpans[1].scopeSpans[0].spans[0];
		const events = chat.events.map((event) => [
			event.name,
			Object.fromEntries(event.attributes.map((kv) => [kv.key, Object.values(kv.value)[0]])),
		]);
		// Only messages after the last assistant turn count as new input.
		expect(events).toEqual([
			["gen_ai.content.input", { role: "tool", type: "tool_call_response", content: "ls output" }],
			["gen_ai.content.reasoning", { content: "**Plan** read the file" }],
			["gen_ai.content.tool_call", { name: "read", id: "t2", arguments: '{"path":"a"}' }],
		]);
	});
});
