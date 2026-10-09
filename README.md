# subagent-otel

Traces a pi session and its subagent fleet as OpenTelemetry GenAI spans: the parent's LLM and tool
calls, each subagent's LLM and tool calls, and what passes between them (supervisor questions and
replies, steering, results).

Works with [pi-subagents](https://www.npmjs.com/package/pi-subagents) (tested with 0.73.1) for full
fleet tracing, and with `@tintinweb/pi-subagents` for run-level spans. Without either, it still traces
your own session and the `subagent` tool.

## Install

```sh
pi install npm:pi-subagent-otel          # add to your pi settings
pi -e npm:pi-subagent-otel               # or try it for one session
```

## Use

Run pi as usual. The footer shows detection state and the number of finished subagent spans, and
`/subagent-trace` prints the span tree (`/subagent-trace json` for raw span summaries).

Every finished span is appended to a JSON-lines trace file, by default next to the session file as
`<session>.otel.jsonl`. Sessions without a session file (`--no-session`) write no file unless you pass
a directory or name.

| Flag | Default | Effect |
|---|---|---|
| `--subagent-otel-content` | `none` | `full` records prompts, responses, reasoning, tool arguments and results (see decision 1) |
| `--subagent-otel-dir` | | Write `<dir>/<YYYY-MM-DD>-<name>.jsonl` instead of next to the session file |
| `--subagent-otel-name` | `trace` | Name part of that file |
| `--subagent-otel-exporter` | `file` | `none` turns the trace file off |

Example: `pi --subagent-otel-content full --subagent-otel-dir subagent-traces --subagent-otel-name explore`.

Each line is a `span` record (one finished span) or a `trace` record (written at session start and
shutdown, with the parent's pid and hostname).

## How child conversations reach the parent

`child.ts` is not a tool. A subagent's model never calls it and does not know it exists: it registers
no tools, commands or prompt changes, so the child sees the same tools and system prompt and spends
no extra tokens. It is a pi **extension** that pi-subagents loads into every child, and **pi itself**
calls its handlers as the child session runs.

**Where children run.** Not every subagent is its own process:

| Run kind | Where the child session runs |
|---|---|
| Foreground (`subagent` without `async`) | The parent's own process, as a separate pi session with its own event bus |
| Async (`async: true`) | A runner process pi-subagents spawns per run; the child sessions run inside it |
| External CLI agents (claude-code, codex, cursor) | Another CLI, not a pi session, so `child.ts` never loads there |

**How `child.ts` gets in.** pi-subagents has a required-child-extensions registry
(`registerRequiredChildExtensions`, export `pi-subagents/required-child-extensions`), stored as
`globalThis[Symbol.for("pi-subagents.required-child-extensions.v1")]` =
`{ version: 1, bySession: Map<parentSessionId, [{ id, path }]> }`. It takes a **file path to a pi
extension**, not tools or data. (pi-subagents' `./child-tool-plan` export is different: it decides
which tools a child may use.)

1. Parent `session_start`: `child-registration.ts` adds `child.ts` under the parent's session id;
   `index.ts` starts the fleet server and sets `PI_SUBAGENT_OTEL_SOCKET` in `process.env`.
2. The parent model calls `subagent`: pi-subagents adds the registered paths to the child's launch
   plan (foreground: `buildInProcessChildLaunch`; async: copied into the runner's config; nested
   children inherit them).
3. The child session is created with `child.ts` in its extension paths. Foreground children load
   none of your other installed extensions, but required ones still load. If a required extension
   fails to load, pi-subagents fails the launch, so `child.ts` is inert without a socket path and
   wraps every handler.
4. Inside the child, pi fires its standard hooks and `child.ts` forwards each one: directly when the
   parent's fleet server is in the same process, over the socket otherwise.

| Child session does | pi fires | `child.ts` sends to the parent |
|---|---|---|
| Session opens | `session_start` | `hello` (session id, session file, pid) |
| About to call the model | `context_with_system` (exact transcript sent) | `llm.start` with the messages |
| Model replies | `message_end` (assistant) | `llm.end` with output, reasoning, usage |
| Runs a tool | `tool_execution_start` / `tool_execution_end` | `tool.start` / `tool.end` with arguments and result |
| Session closes | `session_shutdown` | `bye` |

pi-subagents only loads `child.ts`; pi fires the hooks; `child.ts` turns hooks into events; the parent
turns events into spans. Evidence from a live run: the child's launch metadata lists
`launchResolvedExtensions.required: ["subagent-otel"]`.

## Viewing in Jaeger

```sh
docker run -d --name pi-jaeger -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:2.10.0
npx pi-subagent-otel-push ~/.pi/agent/sessions/<project>/<session>.otel.jsonl
```

Open http://localhost:16686 and pick service `pi`. A second argument sets another OTLP/HTTP endpoint
(default `http://localhost:4318/v1/traces`); any OTLP backend works. `otlp.ts` converts the trace file
to OTLP/JSON:

- Exact start and end times for every span, including child spans delivered late.
- One service per role: `pi` for the parent, `pi-subagent:<agent>` for each subagent's conversation.
- A span link (`pi.link.type=launched_by`) from each async run to the `execute_tool subagent` call
  that launched it. In Jaeger it shows as a reference on the run span.
- Process boundary. Each child span records `process.pid` (from the child's hello); each run span
  records `pi.subagent.execution` (`in_process` for foreground children, `separate_process` for
  async runners) and `pi.subagent.process.pid`. In OTLP every process is its own resource
  (`process.pid`, `host.name`, `pi.process.role` = `main` or `subagent_runner`, shown in Jaeger's
  Process panel), and a run that crosses into another process has span kind CLIENT.
- Readable conversation (with `--subagent-otel-content full`). Each `chat` span gets logs:
  `gen_ai.content.input` for messages new since the model's previous turn, then
  `gen_ai.content.reasoning`, `gen_ai.content.output` and `gen_ai.content.tool_call` for what it
  produced. Reasoning is what the provider returns: OpenAI sends a summary (sometimes empty) and keeps
  the full reasoning encrypted.

## Development

```sh
npm install --ignore-scripts
npm run check   # TypeScript
npm test        # vitest, against the published pi packages
npm run build   # compiles the push CLI to dist/
```

## Vocabulary

| Term | Meaning |
|---|---|
| **OTel** (OpenTelemetry) | The observability project as a whole: data model, semantic conventions, language APIs and SDKs, and the Collector |
| **OTLP** (OpenTelemetry Protocol) | OTel's wire format for sending telemetry to a backend (protobuf or JSON, over gRPC or HTTP). Backends such as Jaeger ingest OTLP |
| **Trace** | Everything that happened for one unit of work, here one pi session. Identified by a 32-hex-character trace id |
| **Span** | One timed operation in a trace (an LLM call, a tool call, a subagent run). Has a 16-hex-character span id, a parent span id, start and end times, status, attributes and events |
| **Parent span** | The span a span is nested under. Parent ids alone build the tree |
| **Span event** | A timestamped note inside a span, such as `pi.subagent.steered` |
| **Span link** | A reference from one span to another that is not its parent, for relationships a tree can't show. Supported by OTel and OTLP, but not by pi-telemetry |
| **Resource** | Attributes describing what produced the spans, most importantly `service.name` |
| **Semantic conventions** (semconv) | OTel's standard attribute and span names. The **GenAI** conventions cover LLM calls (`chat`), tool calls (`execute_tool`) and agents (`invoke_agent`) |
| **Exporter** | Code that sends finished spans somewhere: a file, an OTLP endpoint |
| **pi-telemetry** | pi's own minimal span API (`TelemetryContext`). Takes no start time, links or explicit parent |

pi and pi-subagents terms, and how they map onto spans:

| Term | Meaning |
|---|---|
| **Run** | One subagent invocation in pi-subagents: one `subagent` tool call or one async launch, identified by a run id. A pi-subagents concept, not an OTel one |
| **Run span** | The one span that records a run: `invoke_agent <agent>` for a single agent, `invoke_workflow subagent.<mode>` for parallel and chain runs. Carries the run id as `pi.subagent.id`. The run's work (per-agent spans, child conversation) is nested under it |
| **Run vs span** | A run is what happened; spans are how it is recorded. One run produces one run span plus any number of spans below it. Example: a foreground `delegate` run is one `invoke_agent delegate` span with `chat`, `execute_tool bash`, `chat` underneath |
| **Child** | The pi session a run starts for one agent. A parallel run has one child per agent |
| **Conversation** | A session's own LLM and tool calls: `chat` and `execute_tool` spans. The parent has one, and so does each child |
| **Foreground run** | The parent's `subagent` call blocks until the child finishes. The child runs in the parent's process (`pi.subagent.execution=in_process`) |
| **Async run** | `subagent` with `async: true` returns at once and the child runs in a separate runner process (`pi.subagent.execution=separate_process`, span kind CLIENT). The result arrives later |
| **Parent** | The pi session you talk to. Its spans have service `pi` |
| **Fleet channel** | How children deliver their conversation to the parent: a direct call for in-process children, a local socket for runner processes |
| **Unattributed** | Child conversation spans that could not be matched to a run, kept under the root with `pi.subagent.unattributed=true` |

This extension produces spans in the OTel data model with GenAI attribute names, using its own tracer
(not the OTel SDK) and its own JSON-lines file format (not OTLP).

## Decisions

Each decision states the problem, the choice, the alternatives considered, and what it costs.

### 1. Content capture: off by default, full on request

**Problem.** A trace of names and token counts can't explain behavior. Example: a researcher subagent
failed. The span showed `ERROR(failed)` and 13,334 input tokens. Why it failed is only in the content:
it had no web tools, asked the supervisor for a location, and was told to write a limitation note.
But content also carries secrets and private data, and this package is published for anyone to install.

**Choice.** `--subagent-otel-content` controls it:
- `none` (default): no prompts, responses, reasoning, tool arguments or results, task or result text,
  or steering text, anywhere: not in the trace file, not in external telemetry.
- `full`: all of it, in the trace file and in external telemetry, with no size cap.
  Pass `--subagent-otel-content full` when you want it.

**How this compares to other tools.**

| Tool | Content by default |
|---|---|
| OpenTelemetry GenAI conventions and the official instrumentations | **Off.** Instrumentations should not capture content by default; it is enabled with `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` |
| OpenLLMetry (Traceloop) | **On.** `TRACELOOP_TRACE_CONTENT` defaults to `true`; the docs suggest turning it off in production |
| OpenInference (Arize Phoenix) | **On.** `OPENINFERENCE_HIDE_INPUTS` / `_OUTPUTS` default to `false` |

The default follows OTel, because an installed package should not start writing secrets to disk
without being asked. When you are debugging agent behavior, opt in, as OpenLLMetry and OpenInference
do by default.

**Costs of `full`.**
- Secrets in tool arguments or results (for example a `bash` command with a token) are written to
  the trace file and sent to any external backend.
- Every `chat` span stores the full context it sent, as the conventions define
  `gen_ai.input.messages`. Each call repeats the history, so trace size grows quadratically with
  conversation length. Accepted for now; recording only new messages per call is a later option.
- External backends cap attribute size and will truncate or drop large values. The trace file is the
  complete record.

### 2. Flush finished spans to disk, keep only summaries in memory

**Problem.** With full content, keeping every span in memory grows without bound, and rewriting the
whole trace file on every span end is quadratic in writes.

**Choice.** The trace file is always on and append-only: one JSON line per span, written when the
span ends. Memory holds open spans plus a small summary per finished span (ids, name, times, status,
usage). The footer and `/subagent-trace` render from summaries; full content is read from the file.

**Alternatives.** Keep everything in memory (unbounded). Write only on shutdown (a crash loses the
whole trace).

**Costs.** Spans still open at a crash are lost. Readers of the old single-document `.json` format
must switch to JSON lines.

### 3. Run our own code inside each subagent

**Problem.** Each pi session has its own in-process event bus. Foreground subagents run in the parent
process but as separate sessions; async subagents run in another process. Neither one's LLM or tool
events reach the parent's bus. pi-subagents forwards only lifecycle and status summaries.

**Choice.** Register a small child extension through pi-subagents' public
`registerRequiredChildExtensions` hook. pi-subagents then loads it into every child it launches
(foreground, async and nested).

**Alternatives.** Rebuild child conversations from their `session.jsonl` after each run ends. This
is kept as the fallback, but it isn't live and can't give external backends correct timing (see
decision 6).

**Costs.** Doesn't reach children that pi-subagents runs through external CLIs (claude-code, codex,
cursor), or children of `@tintinweb/pi-subagents`. Those keep run-level spans only.

### 4. A local socket back to the parent

**Problem.** The child extension needs to deliver events to the parent while the child runs.

**Choice.** The parent listens on a Unix domain socket (a named pipe on Windows) and passes the path
through `process.env`. Foreground children share that environment; async runners inherit it when
spawned. Children stream newline-delimited JSON, one way.

| Alternative | Why not |
|---|---|
| Per-child file tailed by the parent | Polling latency and file cleanup, and it duplicates `session.jsonl` |
| Each process exports OTLP to a collector | Standard OTel, but the parent's trace file, footer and `/subagent-trace` would never see child spans |

**Costs.** If the parent exits before a child finishes, that child's live events are lost. Children
running on another machine can't reach the socket.

### 5. Sources emit meaning; one module maps it to OTel

**Problem.** Three paths produce the same kind of data: the parent's own events, live child events,
and child events rebuilt from session files. If each built spans itself, the GenAI attribute logic
would exist three times.

**Choice.** Sources and the child extension emit semantic events ("LLM call started with these
messages", "tool X ended with this result"). Only `instrumentation.ts` turns them into span names
and `gen_ai.*` attributes. The child extension sends these events, not spans, so it never needs to
know trace ids or the GenAI conventions.

**Costs.** One intermediate event type to maintain.

### 6. Match each child to its run by session file path

**Problem.** A child doesn't reliably know which run it belongs to. Its session name is a display
name built from agent and task text. The `subagent-{agent}-{runId}-{n}` form appears only as a
fallback.

**Choice.** pi-subagents lays out child sessions as `<sessionRoot>/run-<index>/session.jsonl`. The
child reports its session file when it connects. The parent matches it against `sessionRoot` from
`subagent:async-started` (async), the single open `subagent` tool call (foreground), or completion
payloads (everything else). Unmatched events are buffered until a match.

**Costs.**
- With several foreground `subagent` calls running at once, and for slash or prompt-template runs,
  the match happens only at run end, so those child spans appear late.
- The path layout and payload fields aren't versioned by pi-subagents. If they change, child spans
  land under the session root marked `pi.subagent.unattributed` instead of under their run. A test
  against the locally installed pi-subagents guards this.
- The clean fix is upstream: pi-subagents exposing child identity to child-side extensions.

### 7. Attribute joins instead of span links

**Problem.** pi-telemetry's `startSpan` has no start time, no links and no explicit parent. Its
in-memory adapter also drops children of spans that have already ended. An async subagent's
launching tool call ends immediately, so the subagent's span can't be its child.

**Choice.** The async `invoke_agent` span is a sibling of its launching `execute_tool subagent` span,
joined by `pi.subagent.launch_tool_call_id`. Supervisor questions and replies are joined by
`pi.subagent.supervisor.request_id`, and steering by `pi.subagent.target_run_id`.

**Costs.**
- Trace UIs won't draw these relationships; you find them by querying the attribute.
- Spans that arrive late (buffered or rebuilt) get the wrong start time in external backends. They
  are marked `pi.span.reconstructed` and carry their true times as attributes. The trace file always
  has true times.

### 8. Follow the GenAI conventions, add `pi.*` where they stop

**Choice.** Use `invoke_agent`, `chat`, `execute_tool` and `invoke_workflow` with their standard
attributes, including the content attributes. The conventions have no model for messages between
agents, so fleet interactions use `pi.subagent.*` attributes and span events.

**Costs.** The GenAI conventions are still in Development status, and names can change between
releases. `invoke_workflow` is a recent addition (semconv v1.41, per secondary sources); confirm it
against the spec version we target.

## Not covered

- Children run through external CLIs (claude-code, codex, cursor), and `@tintinweb/pi-subagents`
  children: run-level spans only.
- Children of a parent that exits first: live events lost, no fallback.
- Children running in memory with no session file, if they also fail to connect: turns lost.

The full list, with examples, is in [DESIGN.md](DESIGN.md#limitations).
