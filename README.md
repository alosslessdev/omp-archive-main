# omp-archive

Export the **entire** history of an omp session as one zip: the main transcript,
every subagent session (recursively, verbatim), all untruncated tool /
background-job output, live background-job state, and a standalone HTML viewer.

`/export` embeds subagent *entries* in a viewer HTML and `/dump` covers the live
main conversation. Neither ships a subagent's own transcript file, its sibling
tool-output logs, or background-job state. This plugin archives all of it.

## Install

```bash
# local checkout / development (symlinked, edits are live)
omp plugin link /home/asdf/projects/omp-archive

# git
omp plugin install github:<user>/omp-archive

# marketplace (this repo ships .omp-plugin/marketplace.json)
/marketplace add <user>/omp-archive
/marketplace install archive@omp-archive

# one-off
omp --extension /home/asdf/projects/omp-archive
```

## Usage

```
/archive                      # -> ./omp-archive-<session>.zip
/archive /tmp/session.zip
/archive --no-artifacts       # skip the artifact/log tree (smaller zip)
/archive --no-viewer          # skip viewer.html
```

The same operation is exposed as the `export_session_archive` tool so the agent
can archive a session on request.

## What's inside

| Path | Contents |
| --- | --- |
| `manifest.json` | Index of everything below: counts, sizes, subagent list, omissions |
| `session.jsonl` | The main session transcript, byte-for-byte |
| `agents.json` | Live per-agent state captured while the session ran (model, system prompt, tools) |
| `jobs.json` | Background/async jobs: `completed` (recovered from every transcript) plus `live` (running/recent at archive time) |
| `artifacts/` | **Every** file under the session artifact directory, byte-for-byte |
| `viewer.html` | Standalone HTML viewer with all subagent sessions embedded |
| `README.md` | Human-readable index of the archive |

`artifacts/` is the complete record: each subagent's own
`<AgentId>.jsonl` (nested children under `<AgentId>/`), the
`*.bash.log` / `*.eval.log` / `*.read.log` files holding the **full,
untruncated** tool and background-job output that the transcript truncates, and
`*.jsonl.tombstone` kill markers.

## Limits

- **Background jobs.** `jobs.json` lists two sources: `completed` — every
  settled async job recovered from the `async-result` entries of the main and
  subagent transcripts (label, status, duration, output handle) — and `live`,
  the running/recent jobs observed while the extension was loaded. A job's full
  output is in its owning transcript plus the matching `artifacts/*.log`.
- **Subagent system prompts / tool lists** are not persisted by the host, so
  they appear in `agents.json` only for sessions this process observed. Each
  subagent's full *conversation* is always present, verbatim, under `artifacts/`.
- The archive is not redacted: it can contain secrets, raw context, and images.
- Paths with spaces are not supported in `/archive` arguments (same parsing as
  `/export`).
