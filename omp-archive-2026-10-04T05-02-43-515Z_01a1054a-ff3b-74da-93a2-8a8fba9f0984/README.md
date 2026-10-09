# Session archive

Generated 2026-10-09T06:03:16.321Z from session `01a1054a-ff3b-74da-93a2-8a8fba9f0984`.

## Layout

| Path | Contents |
| --- | --- |
| `manifest.json` | Index of everything below (counts, sizes, subagent list) |
| `session.jsonl` | The main session transcript, verbatim |
| `agents.json` | Live per-agent state captured while the session ran (model, system prompt, tools) |
| `jobs.json` | Background jobs: `completed` (recovered from transcripts) + `live` (running/recent at archive time) |
| `artifacts/` | Every file under the session artifact directory, verbatim |
| `viewer.html` | Standalone HTML viewer (all subagent sessions embedded) |

`artifacts/` is the important part: it holds each subagent's own
`<AgentId>.jsonl` transcript (recursively nested), the session's
`*.bash.log` / `*.eval.log` / `*.read.log` files with the **full, untruncated**
tool and background-job output, and `*.jsonl.tombstone` kill markers.

## Background jobs

7 completed jobs recovered from the transcripts (main + every subagent); full list in `jobs.json`. A live snapshot of running/recent jobs for Main is also included. Per-job output lives in the owning transcript and in `artifacts/*.log`.

## Subagents (0)

_No subagent sessions were recorded for this session._

## Totals

10 files, 6089168 bytes.
