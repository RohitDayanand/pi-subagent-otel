# subagent-otel: fleet tracing design

Status: design for review. The reasoning behind each decision is in [README.md](README.md). Event names and payloads were read from pi-subagents 0.73.1
(`~/.pi/agent/npm/node_modules/pi-subagents/src`). File references below are relative to that `src`.

## Problem

The current trace has one span per subagent run, built from completion summaries. It is missing:

1. **The child conversation.** Every LLM call and tool call a subagent makes, with content.
2. **The fleet conversation.** What a child asked the supervisor, what the parent replied, steering
   messages, and per-child progress inside a workflow.
3. **The parent conversation.** The parent's own LLM and tool calls around the subagent runs.

Example from a real run: the async `researcher` made 3 LLM calls, asked the supervisor for a location
via `contact_supervisor`, was told to write a limitation note, and called `write`. The parent replied
with `subagent_supervisor` and fetched the weather itself with `curl`. The trace showed two
`invoke_agent researcher` spans and nothing else.

## Decisions

- **Content capture is opt-in.** `--subagent-otel-content full` records prompts, responses, reasoning,
  tool arguments, tool results, and supervisor and steering text in the trace file and external
  telemetry. The default, `none`, records none of it. (This
  design was first written with content on by default; the default changed when the extension was
  packaged for publishing. See README decision 1.)
- **No size cap.** Quadratic growth from repeated context is accepted for now.
- **Spans are flushed to disk when they end, not kept in memory.** Memory holds only open spans plus a
  small summary per finished span (see Storage).

## Why the bus alone cannot fix (1)

`pi.events` is an in-process event emitter, and each pi session gets its own.

| Child kind | Where it runs | Its events reach the parent bus? |
|---|---|---|
| Foreground (`subagent` tool, no `async`) | In the parent process, as a separate `AgentSession` with its own resource loader and event bus (`runs/shared/child-session.js:226`) | No |
| Background (`async: true`) | A runner process spawned per run (`runs/background/async-execution.js:483`), which hosts the child sessions in-process | No |
| External runners (claude-code, codex, cursor adapters) | Another CLI | No, and not pi sessions |

pi-subagents forwards only summaries to the parent bus: lifecycle, child status, control (attention)
events, and steering notices. Getting the child conversation live needs our own code running inside
each child, plus a channel back to the parent.

## Architecture: three channels, one vocabulary

```
parent process                                  child session (in-process or runner)
──────────────                                  ────────────────────────────────────
pi events (agent/message/tool)  ─┐              child.ts (required child extension)
pi-subagents bus events        ──┼─> sources ─> SourceEvent ─> instrumentation ─> tracer ─> trace file
fleet IPC socket   <─────────────┼─ NDJSON events ──────────┘                     └──> external telemetry
child session.jsonl (fallback) ──┘
```

Sources emit **semantic** events ("an LLM call started with these messages", "tool X ended with this
result"), not spans. `instrumentation.ts` is the only place that maps events to GenAI span names and
attributes. The child extension sends the same semantic events over IPC, and the session-file fallback
produces them from `session.jsonl`. All three paths go through one mapping.

## 1. Bus events (pi-subagents, parent process)

### Listen for

| Event | Payload fields we read | Mapping |
|---|---|---|
| `subagents:rpc:v1:request` / `:reply:{id}` / `subagents:rpc:v1:ready` | `data.version` | Detection (exists) |
| `subagent:async-started` | `id`, `mode`, `agent`, `agents`, `task`, `goal`, `chainStepCount`, `workflowKey`, `asyncDir`, `sessionRoot`, `parentWorkflowRunId` | Start `invoke_agent {agent}` or `invoke_workflow subagent.{mode}` (exists). New: `sessionRoot` correlates child connections; `parentWorkflowRunId` gives nesting; task text is recorded |
| `subagent:async-complete` | `runId`, `mode`, `state`, `success`, `error`, `summary`, `durationMs`, `results[]` (`agent`, `index`, `usage`, `model`, `exitCode`, `stopReason`, `summary`, `sessionPath`, `children`), `nestedChildren` | End the run span (exists). New: summary text, `results[].sessionPath` for the fallback |
| `subagent:child-status` | `runId`, `childId`, `status` (`started`/`stopping`/`stopped`), `ts`, `stepIndex`, `agent`, `childRunId`, `workflowKey`, `phase`, `label`, `reason` | Start or end a live per-child `invoke_agent {agent}` under a workflow span. Today those child spans only appear at completion, all with the parent's duration |
| `subagent:control-event` | `event.type` (`needs_attention`/`active_long_running`), `event.reason`, `event.message`, `event.runId`, `event.index`, `event.toolCallId`, `event.turns`, `event.tokens`, `event.toolCount`, `event.currentTool`, `event.elapsedMs`, `event.recentFailureSummary`, `childIntercomTarget`, `noticeText` | Span event `pi.subagent.needs_attention` or `pi.subagent.active_long_running` on the child's `invoke_agent` span |
| `subagent:steering-notice` | `runId`, `requestId`, `state` (`failed`/`partial`/`recovered`), `message` | Span event `pi.subagent.steering` on the run span |
| `subagent:result-intercom` | `to`, `message`, `requestId` | Span event `pi.subagent.result_delivered` with the delivered text |
| `subagent:foreground-complete` | `runId`, `taskIndex`, `agent`, `state`, `success`, `summary`, `exitCode`, `interrupted`, `stopped`, `timedOut`, `turnBudgetExceeded`, `sessionFile` | End a detached foreground child; `sessionFile` for the fallback |
| `subagent:process-terminal` | `runId`, `state`, `observedAt`, `instances[]` (runner exit info), `resumeDisposition` | Span event `pi.subagent.process_exit` on the run span |
| `subagent:slash:started` / `subagent:slash:update` / `subagent:slash:response` | `requestId`, progress and result details | Run span for subagents launched by slash command. These have no `subagent` tool call and, in foreground, no `async-*` events, so today they are untraced |
| `prompt-template:subagent:started` / `:update` / `:response` | `requestId`, `ownerRunId`, `nodeId`, result details | Same, for prompt-template delegation |

### Ignore, and why

| Event | Reason |
|---|---|
| `subagent:control-intercom` | Same control event as `control-event`, routed to intercom. Duplicate |
| `subagent:result-intercom-delivery` | Delivery bookkeeping for `result-intercom` |
| `pi-subagents:runtime-agent-register:v1`, `pi-subagents:inspector-register:v1`, `herdr:*`, MCP runtime snapshot | Registration and UI plumbing, not run activity |

### `@tintinweb/pi-subagents` (checked against 0.19.0)

| Event | Status |
|---|---|
| `subagents:rpc:ping` (protocol v2), `subagents:ready` | Detection (exists) |
| `subagents:created`, `subagents:started` | Run start, `background`, `queued_ms` (exists) |
| `subagents:completed`, `subagents:failed` | Run end with usage, status, tool uses, duration (exists). New: `result` and `error` text |
| `subagents:steered` | Span event (exists). New: steering `message` text |
| `subagents:compacted` | Span event (exists) |
| `subagents:scheduled` (`fired` with `jobId`, `agentId`), `subagents:scheduler_ready` | Not handled. `fired` could link a run to its scheduled job |

Gaps that stay:
- tintin emits lifecycle events only for top-level agents. Children owned by another agent or by a
  workflow are invisible on the bus.
- No per-turn events: tintin tracks each assistant message's usage internally but does not emit it.
- Live child turns are not covered. tintin runs children in-process and its default agents load every
  discovered extension (`extensions: true`), so subagent-otel would load in children when installed
  through settings, but not when loaded with `--extension`. tintin has no required-extension hook and
  children don't learn their agent id, so matching would need its own design.

## 2. Parent conversation (pi extension events, parent process)

| pi event | Mapping |
|---|---|
| `agent_start` / `agent_end` | `invoke_agent pi`, one per user prompt, under the `pi.session` root |
| `before_provider_headers` | Start `chat {model}`. Closest event to the HTTP request, so the span includes time to first token |
| `context_with_system` | Input content for the `chat` span: system prompt and messages as sent |
| `message_end` (assistant) | End `chat {model}` with output content, usage, response model, stop reason, error |
| `tool_execution_start` / `tool_execution_end` | `execute_tool {tool}` for every tool, with arguments and result |

The `subagent` tool is no longer special-cased as a span source. Its `execute_tool subagent` span is
the parent of a foreground run's `invoke_agent`. Management calls (`status`, `list`, `steer`) become
ordinary `execute_tool` spans with `pi.subagent.action` and `pi.subagent.target_run_id` instead of
being discarded.

## 3. Child conversation (IPC, live)

### Loading the child extension

pi-subagents has a public contract for this: `registerRequiredChildExtensions({ sessionId,
extensions: [{ id, path }] })` (export `pi-subagents/required-child-extensions`). It stores the list on
`globalThis[Symbol.for("pi-subagents.required-child-extensions.v1")]` as
`{ version: 1, bySession: Map<parentSessionId, [{ id, path }]> }`. Every child launched for that parent
session loads the listed module:

- foreground: `buildInProcessChildLaunch` (`runs/shared/child-launch.js:74`)
- async: snapshotted into the runner config (`runs/background/async-execution.js:849`)
- nested descendants: inherited through `inheritedChildRuntime` (`runs/background/subagent-runner.js:520`)
- external runners: excluded (`externalRunner ? []`)

At `session_start` the parent registers `subagent-otel/child.ts` under
`ctx.sessionManager.getSessionId()`, the same id pi-subagents uses (`subagent-executor.js:995`). It
writes the v1 shape directly instead of importing pi-subagents, so the example still loads without it.
On `session_shutdown` it removes the entry.

### Transport

At `session_start` the parent listens on a Unix domain socket (a named pipe on Windows; `node:net`
handles both). It publishes the path in `process.env.PI_SUBAGENT_OTEL_SOCKET`:

- foreground children run in the parent process and read the same `process.env`
- the async runner is spawned with `...process.env` (`async-execution.js:470`), so it inherits it

The child connects on its `session_start` and writes newline-delimited JSON, one way, child to parent.

| Option | Verdict |
|---|---|
| Socket, NDJSON | **Chosen.** Push-based and live. The parent sees a disconnect when a child dies |
| Append-only file per child, tailed by the parent | What pi-subagents does for control events. Polling latency, file cleanup, and a second copy of data already in `session.jsonl` |
| Each process exports OTLP to a collector, linked by `traceparent` | Standard OTel, but the parent's trace file, footer and `/subagent-trace` would never see child spans |

### Protocol v1

```jsonc
{"v":1,"type":"hello","sessionId":"…","sessionFile":"…/run-0/session.jsonl","pid":123}
{"v":1,"type":"event","event":{"kind":"llm.start","callKey":"1","model":"gpt-5.5","provider":"openai","input":{…},"t":1791496183000}}
{"v":1,"type":"event","event":{"kind":"tool.start","toolCallId":"call_x","toolName":"contact_supervisor","arguments":{…},"t":…}}
{"v":1,"type":"event","event":{"kind":"tool.end","toolCallId":"call_x","result":{…},"isError":false,"t":…}}
{"v":1,"type":"event","event":{"kind":"llm.end","callKey":"1","output":{…},"usage":{…},"stopReason":"toolUse","t":…}}
{"v":1,"type":"bye"}
```

The child sends semantic events with child-local keys and timestamps. It never sends trace ids or span
ids; the parent assigns them on ingest.

### Correlation: which run is this connection?

The child knows its session file. It does not reliably know its run id: its session name is a display
name built from agent and task text (`shared/child-session-name.js`), and is the intercom target
`subagent-{agent}-{runId}-{n}` only when pi-intercom cannot claim that target as its id.

pi-subagents lays out child sessions as `<sessionRoot>/run-<index>/session.jsonl`, where `sessionRoot`
is `<base>/<executionRunId>` (`subagent-executor.js:6873-6893`). The parent uses that:

| Run kind | How the parent matches a connection | When |
|---|---|---|
| Async | `async-started.sessionRoot` is the session file's grandparent directory; `run-<index>` gives the child index | At child start |
| Foreground, one `subagent` call open | The only open call | At child start |
| Foreground, several `subagent` calls open at once | Progress updates carry neither run id nor session file (`runs/foreground/execution.js:849`), so the match waits for the tool result's `details.runId` and `results[].sessionFile` | At run end |
| Slash / prompt-template | The response's result details | At run end |

Until a connection is matched, its events are buffered and replayed under the child's `invoke_agent`
span on match. A connection still unmatched at session end is attached under the root with
`pi.subagent.unattributed=true`.

The clean fix belongs upstream: ask pi-subagents to expose child identity to child-side extensions,
for example a `subagents:child:identity` event on the child bus or a field on `ctx`. Environment
variables can't carry it, because foreground children share one process.

### Failure behavior

- No socket path, or the connection fails: the child extension stays inert and the session-file
  fallback applies.
- The parent never blocks on IPC. Malformed lines are counted in `dropped`.
- Every child extension handler is wrapped so it can never throw into the child session.

## 4. Child conversation (session file, fallback): dropped

Not built, by decision. A child that never connects keeps its run span only. Kept below for reference.

When a run completes, for each child session file with no IPC `hello`, the parent streams
`session.jsonl` line by line and emits the same semantic events, with content and recorded timestamps:

| Entry | Event |
|---|---|
| `message` role `assistant` (`content`, `usage`, `model`, `stopReason`, `timestamp`) | `llm.start` at the previous entry's timestamp (input = messages so far), `llm.end` at its own |
| `toolCall` content block (`id`, `name`, `arguments`) | `tool.start` at the assistant timestamp |
| `message` role `toolResult` (`toolCallId`, `toolName`, `content`, `isError`, `timestamp`) | `tool.end` |

Spans from this path get `pi.span.reconstructed=true`. A connection that dropped mid-run gets
`pi.subagent.trace_incomplete=true` and the rest of its session is rebuilt from the file, starting
after the last event received.

## Storage: flush to disk, not memory

Today the tracer keeps every span in memory, and the file exporter rewrites the whole trace on every
span end. With full content that is unbounded memory and quadratic disk writes.

New behavior:

- **Trace file is always on**, as append-only NDJSON: one line per finished span, with all attributes
  and events, written when the span ends. Default path: next to the parent session file
  (`<session>.otel.jsonl`). `--subagent-otel-dir` and `--subagent-otel-name` override it.
- **Memory holds** open spans with their content, plus a summary per finished span: ids, name, times,
  status, usage numbers, no content.
- **Footer and `/subagent-trace`** render from summaries.
- **`/subagent-trace json` and the `subagent-otel:rpc:trace` reply** return summaries plus the trace
  file path. Full content is read from the file.
- **Session-file fallback** streams `session.jsonl` instead of loading it whole.

## OTel mapping

GenAI semantic conventions used: `chat`, `execute_tool`, `invoke_agent`, and their content attributes.

| Span | `gen_ai.operation.name` | Attributes |
|---|---|---|
| `pi.session` | none (pi root) | `gen_ai.conversation.id` |
| `invoke_agent pi` | `invoke_agent` | `gen_ai.agent.name=pi`, `gen_ai.conversation.id`, `gen_ai.input.messages` (user prompt), `gen_ai.output.messages` (final answer) |
| `chat {model}` | `chat` | `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`, `gen_ai.usage.*`, `error.type`, `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages` |
| `execute_tool {tool}` | `execute_tool` | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type=function`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `error.type` |
| `invoke_agent {agent}` (subagent) | `invoke_agent` | `gen_ai.agent.name`, `gen_ai.request.model`, usage, `gen_ai.input.messages` (task), `gen_ai.output.messages` (summary), `pi.subagent.*` |
| `invoke_workflow subagent.{mode}` | `invoke_workflow` | Parallel, chain and workflow runs. Secondary sources list `invoke_workflow` among the GenAI agent operations since semconv v1.41; confirm against the spec version we target |

### Span tree

```
pi.session
└─ invoke_agent pi                          (one user prompt)
   ├─ chat gpt-5.5
   ├─ execute_tool subagent                 (foreground launch)
   │  └─ invoke_agent researcher
   │     ├─ chat gpt-5.5                    (child, via IPC)
   │     └─ execute_tool contact_supervisor (child)
   ├─ execute_tool subagent                 (async launch; ends immediately)
   ├─ invoke_agent researcher [async]       (sibling of the launch, not child: see constraints)
   │  ├─ event pi.subagent.needs_attention  (gen_ai.tool.call.id = child contact_supervisor)
   │  ├─ chat gpt-5.5                       (child, via IPC)
   │  ├─ execute_tool contact_supervisor    (child; question text in arguments, reply in result)
   │  └─ execute_tool write                 (child)
   ├─ execute_tool subagent_supervisor      (parent reply)
   └─ execute_tool bash
```

## Linkage model: what the conventions don't cover

The GenAI conventions have no notion of messages between agents. We join them through shared
attribute values, because pi-telemetry has no span links.

| Relationship | Join key |
|---|---|
| Async run ↔ the tool call that launched it | `pi.subagent.launch_tool_call_id` on `invoke_agent` = `gen_ai.tool.call.id` of `execute_tool subagent` |
| Child asks the supervisor | `needs_attention` event's `gen_ai.tool.call.id` = the child's `execute_tool contact_supervisor` |
| Parent replies | `pi.subagent.supervisor.request_id` on the parent's `execute_tool subagent_supervisor` (from `replyTo`) and on the child's `contact_supervisor` span (from result `details.requestId`, `intercom/native-supervisor-channel.js:143`) |
| Parent steers a run | `pi.subagent.target_run_id` on `execute_tool subagent` (action `steer`) = `pi.subagent.id` on the run, plus a `pi.subagent.steering` event on the run |
| Workflow child ↔ child session | `pi.subagent.id`, `pi.subagent.index`, `pi.subagent.session_file` |

## Constraints

From `@earendil-works/pi-telemetry` (`packages/telemetry/src/index.ts`):

- **No backdating.** `startSpan({ name, attributes })` takes no start time, no links and no explicit
  parent. A span's external start is the moment we call it, so child events must stream live.
- **No children of finished spans.** The in-memory adapter turns a child of an already-settled span
  into a no-op (`memory.ts:126`). So an async `invoke_agent` cannot be the child of its launching
  `execute_tool`, which ends immediately. It becomes a sibling, joined by
  `pi.subagent.launch_tool_call_id`.

## What this can do

| You'll see | Example from the run above |
|---|---|
| Every LLM call and tool call inside each pi subagent, live, with full content, model, usage, cost, duration and error type. Foreground, async and nested | Under `invoke_agent researcher`: `chat` (the request for a location), `execute_tool contact_supervisor` (the question and the parent's answer), `execute_tool write` (the limitation note) |
| The parent's own conversation | `chat`, `execute_tool bash` (both `curl` calls with their output), `execute_tool subagent status`, `execute_tool subagent_supervisor` (the reply text) |
| Fleet interactions as span events | `pi.subagent.needs_attention` with the child's message, steering notices, result delivery |
| Live per-child spans in parallel, chain and workflow runs | Each child with its own start and end |
| Subagents started by slash command or prompt template | A run span that is missing today |
| A fallback for children that never connected | Rebuilt from `session.jsonl` at run end |

## Limitations

### Hard limits

1. **External runners get no turns.** claude-code, codex and cursor children are not pi sessions, and
   pi-subagents skips required extensions for them. They get a run span only.
2. **`@tintinweb/pi-subagents` children get no turns.** The loading hook is specific to pi-subagents.
   tintinweb runs keep lifecycle spans only.
3. **Relationships are attribute joins, not drawn edges.** In a trace UI, an async run sits beside the
   tool call that launched it, not under it. A child's question and the parent's reply share a request
   id, but nothing draws an arrow between them. You find these by querying the attribute.
4. **A parent that exits before its children loses them.** Quitting pi while an async child runs kills
   the live connection, and no parent remains to run the fallback. The child's `session.jsonl` stays
   on disk but is not in this trace.
5. **Children with no session file can't use the fallback.** With session saving off, pi-subagents
   runs children in memory. If such a child also fails to connect, its turns are lost.
6. **Remote children only get the fallback, and only with a local session file.** Placed runs (herdr,
   ssh) cannot reach a local socket.

### Degraded cases

7. **Late spans.** Concurrent foreground `subagent` calls, and slash or prompt-template runs, are
   matched only at run end. Their child spans appear in the footer and external telemetry only then.
   Unmatched connections land under the root marked `pi.subagent.unattributed`.
8. **Wrong timing in external backends for late or rebuilt spans.** pi-telemetry stamps spans with the
   time we create them. Buffered spans (case 7), fallback spans and orphan runs get misleading times
   externally. They are marked `pi.span.reconstructed` and carry their true times in
   `pi.span.start_time_ms` / `pi.span.end_time_ms`. The trace file always has true times.
9. **Rebuilt spans are approximate.** `session.jsonl` stores when each message was written, not when
   the request was sent. A rebuilt `chat` span starts at the previous entry, has no time to first
   token, and merges provider retries into one span.
10. **Runs already in flight at `session_start` have no child code.** For example, a resumed session's
    running async children. They get the fallback only.
11. **Unversioned payload fields.** The child-extension registry (v1) and detection ping are versioned.
    `sessionRoot`, `sessionPath`, `results[]` and the `run-<index>` layout are not. If a pi-subagents
    update changes them, matching fails and child spans land unattributed instead of under their run.
    A test against the locally installed pi-subagents guards this.

### Costs of full, uncapped content

12. **Secrets are recorded.** Tool arguments and results can hold tokens or keys, for example in a
    `bash` command. They end up in the trace file and any external backend.
13. **Trace size grows quadratically with conversation length.** `gen_ai.input.messages` on each `chat`
    span is the full context sent, so every call repeats the whole history. A 100-call session with
    a 200K-token context can write gigabytes. A later option is to record only new messages per call
    with a pointer to the previous call (not standard OTel).
14. **External backends will truncate or reject large attributes.** OTLP collectors and vendors cap
    attribute size. The trace file is the complete record.

## Module plan

| File | Role |
|---|---|
| `types.ts` | **Done.** `SourceEvent` (renamed from `RunEvent`) with a `conversation` kind: `agent.start/end`, `llm.start/end`, `tool.start/end`, a `ConversationScope` (parent, or child by session), content fields. `FleetMessage` for IPC |
| `sources/pi-subagents.ts` | Adds `child-status`, `control-event`, `steering-notice`, `result-intercom`, `foreground-complete`, `process-terminal`, slash and prompt-template runs, session-path capture |
| `sources/conversation.ts` | **Done.** pi events → `agent.*`, `llm.*`, `tool.*`. Used by the parent for its own session and by `child.ts` inside each subagent. `sources/tool.ts` stays as the subagent-run source for the `subagent` tool |
| `sources/fleet-ipc.ts` | **Done.** Socket server for async runners, plus a direct in-process path for foreground children so their events are handled before the `subagent` call that runs them ends (over the socket they arrived late and went unattributed). Correlation and buffering live in `instrumentation.ts` |
| `sources/session-file.ts` | Dropped (see section 4) |
| `child.ts` | **Done.** Child-side extension: `sources/conversation.ts` → socket, events stamped with child time |
| `child-registration.ts` | **Done.** Adds `child.ts` to the v1 registry next to other registrants' entries; verified against pi-subagents 0.73.1's `resolveRequiredChildExtensions` |
| `instrumentation.ts` | **Done.** Maps conversation events to `invoke_agent pi`, `chat`, `execute_tool` with content attributes; runs nest under their launching `execute_tool`; child conversations matched by session root, single open call, or result rows, otherwise buffered and kept unattributed |
| `tracer.ts` | **Done.** Keeps open spans in full and finished spans as summaries without `CONTENT_ATTRIBUTES`; hands each finished span to listeners once, in full |
| `file-exporter.ts` | **Done.** Append-only JSON lines, next to the session file by default |
