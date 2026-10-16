# Session archive

Generated 2026-10-16T04:17:47.788Z from session `01a14299-81be-72f5-b71b-2c1d03aa0db9`.

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

6 completed jobs recovered from the transcripts (main + every subagent); full list in `jobs.json`. Per-job output lives in the owning transcript and in `artifacts/*.log`.

## Subagents (0)

_No subagent sessions were recorded for this session._

## Totals

8 files, 3268856 bytes.
