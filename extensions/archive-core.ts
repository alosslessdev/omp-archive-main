/**
 * Pure archive assembly for `/archive`.
 *
 * No omp/host imports: everything is read from the session file and its
 * artifact directory on disk, so the layout can be unit-tested directly against
 * a real session. The extension glue in `archive.ts` supplies live job state and
 * the optional standalone HTML viewer.
 *
 * On-disk session layout (see `session/sub-sessions.ts`):
 *   <sessions>/<encoded-cwd>/<timestamp>_<id>.jsonl        main transcript
 *   <sessions>/<encoded-cwd>/<timestamp>_<id>/             artifact dir
 *     <AgentId>.jsonl                                      a subagent transcript (recursive)
 *     <AgentId>/<Child>.jsonl                              a nested subagent transcript
 *     <toolcall>.bash.log | .read.log | .eval.log          full (untruncated) tool/job output
 *     <AgentId>.jsonl.tombstone                            the agent was explicitly killed
 */
import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createZip, type ZipEntry } from "./zip";

const JSONL_SUFFIX = ".jsonl";

/** One persisted subagent transcript discovered under the artifact directory. */
export interface SubagentEntry {
	/** Slash-joined agent path relative to the main session, e.g. `Scout/Helper`. */
	key: string;
	/** Path inside the archive. */
	file: string;
	entries: number;
	bytes: number;
	/** An `<AgentId>.jsonl.tombstone` sidecar sits next to the transcript. */
	aborted: boolean;
}

/** A background/async job completion recorded in a transcript's `async-result` entry. */
export interface CompletedJob {
	/** `main`, or the slash-joined agent path that owns the job. */
	agent: string;
	/** Durable entry id the completion was recorded on. */
	entryId?: string;
	at?: string;
	/** Short job label, e.g. the background bash/task name. */
	label: string;
	status?: string;
	jobId?: string;
	/** Agent definition the job ran as (e.g. `scout`), when it was a subagent job. */
	jobAgent?: string;
	duration?: string;
	lines?: string;
	size?: string;
	/** Handle for the full output (`agent://<id>` / `artifact://<id>`), when present. */
	fullOutput?: string;
}

const ASYNC_RESULT_MARKER = '"customType":"async-result"';

export interface ArchiveManifest {
	format: "omp-session-archive/v1";
	generatedAt: string;
	source: { sessionFile: string; sessionId: string; cwd: string; title?: string };
	main: { entries: number; bytes: number };
	subagents: SubagentEntry[];
	artifacts: { file: string; bytes: number }[];
	agents: unknown;
	jobs: unknown;
	totals: { files: number; bytes: number };
	omitted: string[];
}

export interface ArchiveOptions {
	sessionFile: string;
	sessionId: string;
	cwd: string;
	title?: string;
	/** Live agent registry snapshot (per-agent state captured by the extension). */
	agents?: unknown;
	/** Live async-job snapshot(s) captured by the extension while the session ran. */
	liveJobs?: unknown;
	/** Include every file under the session artifact directory (logs, blobs). */
	includeArtifacts: boolean;
	/** Standalone HTML export to embed as `viewer.html`. */
	viewerHtmlPath?: string;
	/**
	 * Serialized transcript used when `sessionFile` has not been materialized on
	 * disk yet (a lazy session's first turn). The in-process caller supplies it
	 * from the session manager.
	 */
	sessionJsonl?: Uint8Array;
	/** Notes about content intentionally left out, merged into the manifest. */
	omitted?: string[];
	now?: Date;
}

interface WalkedFile {
	rel: string;
	abs: string;
	bytes: number;
}

async function walkFiles(root: string, rel = ""): Promise<WalkedFile[]> {
	const dir = rel ? path.join(root, rel) : root;
	let dirents: Dirent[];
	try {
		dirents = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return [];
		throw err;
	}
	const out: WalkedFile[] = [];
	for (const dirent of dirents) {
		const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
		const abs = path.join(root, childRel);
		if (dirent.isDirectory()) {
			out.push(...(await walkFiles(root, childRel)));
		} else if (dirent.isFile()) {
			const stat = await fs.stat(abs);
			out.push({ rel: childRel, abs, bytes: stat.size });
		}
		// Symlinks are skipped: the artifact tree is written by the session, and a
		// link could otherwise pull in a file outside the session directory.
	}
	return out;
}

function countJsonlEntries(bytes: Uint8Array): number {
	const text = new TextDecoder().decode(bytes);
	let count = 0;
	for (const line of text.split("\n")) if (line.trim().length > 0) count++;
	return count;
}

/** True for the session's own transcript or an advisor transcript; not a subagent. */
function isMainOrAdvisorTranscript(rel: string): boolean {
	if (rel.endsWith(".bak") || rel.includes(".bak-")) return true;
	const base = rel.slice(rel.lastIndexOf("/") + 1);
	return base.startsWith("__advisor");
}

function parseAttributes(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const match of tag.matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)) out[match[1]!] = match[2]!;
	return out;
}

/** Structural view of the extension's live `AgentRecord` (kept loose: no host import). */
interface AgentSummarySource {
	name?: string;
	kind?: string;
	depth?: number;
	parentId?: string;
	model?: string;
	tools?: unknown;
	systemPrompt?: unknown;
	endedAt?: number;
}

/** Compact per-agent index for the manifest; the full records stay in `agents.json`. */
function summarizeAgents(agents: unknown): unknown {
	if (!agents || typeof agents !== "object") return { count: 0, agents: [] };
	const list = Object.entries(agents as Record<string, AgentSummarySource>).map(([id, record]) => ({
		id,
		name: record.name,
		kind: record.kind,
		depth: record.depth,
		parentId: record.parentId,
		model: record.model,
		tools: Array.isArray(record.tools) ? record.tools.length : undefined,
		hasSystemPrompt: Array.isArray(record.systemPrompt),
		ended: record.endedAt !== undefined,
	}));
	return { count: list.length, agents: list };
}

/**
 * Recover background-job completions from `async-result` transcript entries.
 *
 * Every settled async job (bash, eval, async task/subagent) is delivered back
 * as a `custom_message` with `customType: "async-result"` carrying the job's
 * label, status, duration and a handle to its full output. Those entries are
 * the only durable record of a job once its row is evicted from the live job
 * manager, so the archive indexes them for the main session and every subagent.
 */
function deriveCompletedJobs(transcripts: readonly { agent: string; bytes: Uint8Array }[]): CompletedJob[] {
	const jobs: CompletedJob[] = [];
	for (const { agent, bytes } of transcripts) {
		for (const line of new TextDecoder().decode(bytes).split("\n")) {
			if (!line.includes(ASYNC_RESULT_MARKER)) continue;
			let entry: { id?: string; timestamp?: string; content?: string };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const content = typeof entry.content === "string" ? entry.content : "";
			const headline = /Background job (.+?) has (completed|failed|been cancelled)/.exec(content);
			if (!headline) continue;
			const result = /<([a-z]+)-result\b([^>]*)>/.exec(content);
			const attrs = result ? parseAttributes(result[2]!) : {};
			const metaMatch = /<meta\b([^>]*)\/>/.exec(content);
			const meta = metaMatch ? parseAttributes(metaMatch[1]!) : {};
			jobs.push({
				agent,
				entryId: entry.id,
				at: entry.timestamp,
				label: headline[1]!,
				status: attrs.status ?? headline[2],
				jobId: attrs.id,
				jobAgent: attrs.agent,
				duration: attrs.duration,
				lines: meta.lines,
				size: meta.size,
				fullOutput: /full-output="([^"]+)"/.exec(content)?.[1],
			});
		}
	}
	return jobs;
}

/**
 * Build the archive zip: main transcript, every subagent transcript, all
 * artifact/log files, live job state, the HTML viewer, and a manifest.
 */
export async function buildSessionArchive(opts: ArchiveOptions): Promise<{ zip: Uint8Array; manifest: ArchiveManifest }> {
	const now = opts.now ?? new Date();
	let sessionBytes: Uint8Array;
	try {
		sessionBytes = new Uint8Array(await fs.readFile(opts.sessionFile));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !opts.sessionJsonl) throw err;
		sessionBytes = opts.sessionJsonl;
	}
	const artifactDir = opts.sessionFile.endsWith(JSONL_SUFFIX) ? opts.sessionFile.slice(0, -JSONL_SUFFIX.length) : undefined;

	const walked = opts.includeArtifacts && artifactDir ? await walkFiles(artifactDir) : [];
	const omitted: string[] = [...(opts.omitted ?? [])];
	const subagents: SubagentEntry[] = [];
	const artifacts: { file: string; bytes: number }[] = [];
	const entries: ZipEntry[] = [];
	const transcripts: { agent: string; bytes: Uint8Array }[] = [{ agent: "main", bytes: sessionBytes }];

	for (const file of walked) {
		const bytes = new Uint8Array(await fs.readFile(file.abs));
		entries.push({ name: `artifacts/${file.rel}`, data: bytes });
		artifacts.push({ file: `artifacts/${file.rel}`, bytes: file.bytes });
		if (!file.rel.endsWith(JSONL_SUFFIX) || isMainOrAdvisorTranscript(file.rel)) continue;
		const key = file.rel.slice(0, -JSONL_SUFFIX.length);
		transcripts.push({ agent: key, bytes });
		const tombstone = walked.some(w => w.rel === `${file.rel}.tombstone`);
		subagents.push({
			key,
			file: `artifacts/${file.rel}`,
			entries: countJsonlEntries(bytes),
			bytes: file.bytes,
			aborted: tombstone,
		});
	}
	subagents.sort((a, b) => a.key.localeCompare(b.key));

	const jobs = { live: opts.liveJobs ?? null, completed: deriveCompletedJobs(transcripts) };
	const liveAgents: string[] = [];
	if (opts.liveJobs && typeof opts.liveJobs === "object" && "agents" in opts.liveJobs) {
		const liveAgentsField = opts.liveJobs.agents;
		if (liveAgentsField && typeof liveAgentsField === "object") liveAgents.push(...Object.keys(liveAgentsField));
	}
	entries.push({ name: "session.jsonl", data: sessionBytes });
	entries.push({ name: "agents.json", data: encodeJson(opts.agents ?? {}) });
	entries.push({ name: "jobs.json", data: encodeJson(jobs) });

	if (opts.viewerHtmlPath) {
		try {
			entries.push({ name: "viewer.html", data: new Uint8Array(await fs.readFile(opts.viewerHtmlPath)) });
		} catch (err) {
			omitted.push(`viewer.html: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const aggregateBytes = entries.reduce((sum, e) => sum + e.data.length, 0);
	const manifest: ArchiveManifest = {
		format: "omp-session-archive/v1",
		generatedAt: now.toISOString(),
		source: {
			sessionFile: opts.sessionFile,
			sessionId: opts.sessionId,
			cwd: opts.cwd,
			...(opts.title ? { title: opts.title } : {}),
		},
		main: { entries: countJsonlEntries(sessionBytes), bytes: sessionBytes.length },
		subagents,
		artifacts,
		agents: summarizeAgents(opts.agents),
		jobs: { liveAgents, completed: jobs.completed.length, completedJobs: jobs.completed },
		totals: { files: entries.length + 2, bytes: aggregateBytes },
		omitted,
	};
	entries.unshift({ name: "manifest.json", data: encodeJson(manifest) });
	entries.push({ name: "README.md", data: new TextEncoder().encode(renderReadme(manifest)) });

	return { zip: createZip(entries, now), manifest };
}

function encodeJson(value: unknown): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function renderReadme(manifest: ArchiveManifest): string {
	const jobs = manifest.jobs as { completed?: number; liveAgents?: string[] } | null | undefined;
	const completedCount = typeof jobs?.completed === "number" ? jobs.completed : 0;
	const subagentLines =
		manifest.subagents.length === 0
			? "_No subagent sessions were recorded for this session._"
			: manifest.subagents
					.map(s => `- \`${s.key}\` — ${s.entries} entries, ${s.bytes} bytes${s.aborted ? " (killed)" : ""}`)
					.join("\n");
	return `# Session archive

Generated ${manifest.generatedAt} from session \`${manifest.source.sessionId}\`.

## Layout

| Path | Contents |
| --- | --- |
| \`manifest.json\` | Index of everything below (counts, sizes, subagent list) |
| \`session.jsonl\` | The main session transcript, verbatim |
| \`agents.json\` | Live per-agent state captured while the session ran (model, system prompt, tools) |
| \`jobs.json\` | Background jobs: \`completed\` (recovered from transcripts) + \`live\` (running/recent at archive time) |
| \`artifacts/\` | Every file under the session artifact directory, verbatim |
| \`viewer.html\` | Standalone HTML viewer (all subagent sessions embedded) |

\`artifacts/\` is the important part: it holds each subagent's own
\`<AgentId>.jsonl\` transcript (recursively nested), the session's
\`*.bash.log\` / \`*.eval.log\` / \`*.read.log\` files with the **full, untruncated**
tool and background-job output, and \`*.jsonl.tombstone\` kill markers.

## Background jobs

${completedCount} completed job${completedCount === 1 ? "" : "s"} recovered from the transcripts (main + every subagent); full list in \`jobs.json\`.${jobs?.liveAgents?.length ? ` A live snapshot of running/recent jobs for ${jobs.liveAgents.join(", ")} is also included.` : ""} Per-job output lives in the owning transcript and in \`artifacts/*.log\`.

## Subagents (${manifest.subagents.length})

${subagentLines}

## Totals

${manifest.totals.files} files, ${manifest.totals.bytes} bytes.
${manifest.omitted.length > 0 ? `\nOmitted:\n${manifest.omitted.map(o => `- ${o}`).join("\n")}\n` : ""}`;
}
