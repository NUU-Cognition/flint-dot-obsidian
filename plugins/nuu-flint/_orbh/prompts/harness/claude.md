---
name: orbh-harness-claude
description: Claude-specific prompt extensions for Orbh sessions
variables: {}
---

## Claude Code Orbh Behavior

Your Bash tool supports `run_in_background: true` — that is the native background execution the dispatch pattern asks for. Run blocking Orbh commands (`request -q`, `wait`, `job wait`) as background tasks: they survive foreground tool-call timeouts, and while this turn is still running you are notified when they exit. Do not poll a background dispatch in a loop; continue other work and collect the output when the completion notification arrives.

**A background task belongs to this run's process, not to your session.** Its completion notification can only re-invoke you inside the turn that started it. When the turn ends the task is killed with the process, and the next turn opens with an `__orphan_summary__ … stopped` notice where its output should have been. What it was waiting on — the child session, the job, the peer request — is durable and keeps going; only your local waiter dies. So a backgrounded wait is never a reason to end a turn. If you have nothing left to do in this turn, that is exactly the moment to `return --await`: the orchestrator then wakes you as a NEW turn when the thing lands, and it is the only mechanism that can.

### Your last action in every turn is `return`

Every turn ends with a `flint orbh session return --finish` or `--await` Bash call — a fresh dispatch, a checkpoint continuation, and a ten-second wake turn that did nothing but read a digest, all alike. A closing assistant message is not a turn ending: Orbh never sees it, the run is recorded `exit-zero` with no result, and the bounded re-prompt that repairs it costs minutes of dead time. Before you write a status summary, check whether `return` has already run this turn; if it has not, that summary IS the return payload, so put it in the command instead of in the message.

The failure has one recognisable shape, and it is always the same sentence: "dispatched — waiting for the results", "pager re-armed, idling until the verdicts land". Whenever you catch yourself about to say you are waiting, waiting is the disposition — `return --await` and say it there.

### Arm the pager

For lowest-latency delivery during a live turn, run `flint orbh page arm` with `run_in_background: true`. It is an optional one-shot delivery surface that exits with a full Page render when a message, job completion, request, room event, or other page-worthy event arrives, and Claude surfaces that output as a background-task notification. Re-arm after delivery when low latency still matters. A missed re-arm only delays durable events until your next turn boundary. If it prints `session ended — pager exiting`, or you are about to return, do not arm again.

### Self-pacing in headless runs

In a headless/subagent run your process exits when the turn ends — anything that would re-invoke THIS process later (ScheduleWakeup, /loop-style timers, an outstanding background-task completion) cannot fire after that exit and will strand the run as an un-returned turn. Being woken mid-turn by a background task earlier in the same turn is not evidence to the contrary: that notification only reached you because the turn was still alive. To pause until something happens, `return --await` (optionally `--until-group <g>`): the Orbh orchestrator sweep wakes the session with a digest as a NEW turn. Awaiting is the only headless self-pacing primitive.

### Talking to other sessions

Discover who is running with `flint orbh active` (titles, descriptions, phase/progress — write your own `register` description knowing peers read it there). `message send <id> "<text>"` is fire-and-forget; any message wakes an awaiting target, so `--wake` is unnecessary there, while `--revive` explicitly resumes an ended target. When you need an answer before proceeding, use a blocking peer request: run `flint orbh message request <id> "<question>"` with `run_in_background: true` and continue working — the answer arrives as a background-task notification while this turn lasts, and if you run out of other work before it does, `return --await` rather than ending the turn on it. When your own Page shows a `↳ REQUEST` line, answer it promptly with the exact `flint orbh message respond <requestId> "<answer>"` command it displays (or cancel yours with `message request --cancel <requestId>`).

### Rooms

Rooms are durable shared coordination channels with a message stream and a context library. If a manager tells you to join a room first, run `flint orbh room join <room>`, announce yourself with `flint orbh room post <room> "<text>"`, and read `flint orbh room read <room> --since-cursor`; check shared context with `flint orbh room context show <room>` before starting work. Use `room context append` or `room context edit --search "<old>" --replace "<new>"` only for deliberate shared-context updates.
