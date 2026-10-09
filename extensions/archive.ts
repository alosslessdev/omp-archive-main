/**
 * `/archive` — export the entire history of the current session.
 *
 * Produces one zip holding:
 *   - the main transcript (`session.jsonl`), verbatim
 *   - every subagent session, verbatim (`artifacts/<Agent>/<Child>.jsonl`, recursive)
 *   - the full, untruncated tool and background-job output (`artifacts/*.log`)
 *   - live background-job state (`jobs.json`) for the main agent and any subagent
 *     whose session was observed
 *   - live per-agent state (`agents.json`: model, system prompt, tools)
 *   - a standalone HTML viewer (`viewer.html`) with all subagent sessions embedded
 *   - `manifest.json` + `README.md`
 *
 * The persisted layout is documented in `session/sub-sessions.ts`: a session at
 * `<dir>/<name>.jsonl` keeps its artifact directory at `<dir>/<name>/`, which is
 * also where every subagent transcript and tool-output log lives.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ExportOptions } from "@oh-my-pi/pi-coding-agent/export/html";
import { buildSessionArchive, type ArchiveManifest } from "./archive-core";

/** Live per-agent state captured while the process runs. */
interface AgentRecord {
	id: string;
	name: string;
	kind: string;
	depth: number;
	parentId?: string;
	model?: string;
	systemPrompt?: string[];
	tools?: string[];
	/** Latest async-job snapshot observed for this agent. */
	jobs?: unknown;
	startedAt: number;
	updatedAt: number;
	endedAt?: number;
}

/**
 * Module-level and therefore shared across every session the extension is
 * rebound to in this process (main + each subagent), which is what lets
 * `/archive` in the main session report subagents' live job state.
 */
const agents = new Map<string, AgentRecord>();
const lastJobProbeAt = new Map<string, number>();
const JOB_PROBE_INTERVAL_MS = 2_000;

function modelLabel(ctx: ExtensionContext): string | undefined {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	if (!model?.id) return undefined;
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

/** Record or refresh one agent; never throws into the host's event loop. */
function rememberAgent(ctx: ExtensionContext, opts: { policy?: boolean; jobs?: boolean } = {}): void {
	try {
		const now = Date.now();
		const existing = agents.get(ctx.agent.id);
		const record: AgentRecord = existing ?? {
			id: ctx.agent.id,
			name: ctx.agent.name,
			kind: ctx.agent.kind,
			depth: ctx.agent.depth,
			parentId: ctx.agent.parentId,
			startedAt: now,
			updatedAt: now,
		};
		record.name = ctx.agent.name;
		record.kind = ctx.agent.kind;
		record.depth = ctx.agent.depth;
		record.parentId = ctx.agent.parentId;
		record.updatedAt = now;
		const model = modelLabel(ctx);
		if (model) record.model = model;
		if (opts.policy) {
			try {
				record.systemPrompt = ctx.getSystemPrompt();
			} catch {
				// getSystemPrompt is optional in some modes; keep the last value.
			}
		}
		if (opts.jobs) record.jobs = probeJobs(ctx, record.id);
		agents.set(record.id, record);
	} catch {
		// Extension handlers must not throw into the host.
	}
}

/** Snapshot an agent's async jobs, throttled so per-tool-result probes stay cheap. */
function probeJobs(ctx: ExtensionContext, agentId: string): unknown {
	const now = Date.now();
	if ((lastJobProbeAt.get(agentId) ?? 0) + JOB_PROBE_INTERVAL_MS > now) {
		return agents.get(agentId)?.jobs;
	}
	lastJobProbeAt.set(agentId, now);
	try {
		return ctx.getAsyncJobSnapshot({ recentLimit: 200 }) ?? null;
	} catch {
		return null;
	}
}

interface ArchiveArgs {
	outputPath?: string;
	includeArtifacts: boolean;
	includeViewer: boolean;
}

const ARCHIVE_FLAGS = ["--no-artifacts", "--no-viewer"];

function parseArchiveArgs(args: string): ArchiveArgs {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const unknown = parts.filter(part => part.startsWith("--") && !ARCHIVE_FLAGS.includes(part));
	if (unknown.length > 0) throw new Error(`Unknown option: ${unknown[0]}`);
	const includeArtifacts = !parts.includes("--no-artifacts");
	const includeViewer = !parts.includes("--no-viewer");
	const paths = parts.filter(part => !part.startsWith("--"));
	if (paths.length > 1) throw new Error("Usage: /archive [--no-artifacts] [--no-viewer] [outputPath]");
	return { outputPath: paths[0], includeArtifacts, includeViewer };
}

/** The subset of the extension context the archive needs (satisfied by command and tool contexts). */
type ArchiveContext = Pick<ExtensionContext, "cwd" | "agent" | "sessionManager" | "getAsyncJobSnapshot">;

/** Write the standalone HTML export to a temp file; report the failure instead of hiding it. */
async function renderViewer(sessionFile: string, snapshot: Uint8Array): Promise<{ path?: string; error?: string }> {
	const tmpPath = path.join(os.tmpdir(), `omp-archive-viewer-${randomUUID()}.html`);
	let inputPath = sessionFile;
	let cleanupInput: string | undefined;
	try {
		// The export reads the file from disk; an unmaterialized lazy session has
		// none yet, so export from a temp copy of the in-memory snapshot.
		try {
			await fs.access(sessionFile);
		} catch {
			cleanupInput = path.join(os.tmpdir(), `omp-archive-session-${randomUUID()}.jsonl`);
			await fs.writeFile(cleanupInput, snapshot);
			inputPath = cleanupInput;
		}
		// Runtime-selected host module: the export bundle (embedded template +
		// vendor scripts) is heavy and a host build may not expose it, so a
		// failure here must not take down the archive itself.
		const { exportFromFile } = await import("@oh-my-pi/pi-coding-agent/export/html");
		return { path: await exportFromFile(inputPath, { outputPath: tmpPath } satisfies ExportOptions) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	} finally {
		if (cleanupInput) await fs.rm(cleanupInput, { force: true });
	}
}

/** Build the archive zip for the calling session and write it to disk. */
async function writeArchive(ctx: ArchiveContext, args: ArchiveArgs): Promise<{ outputPath: string; manifest: ArchiveManifest }> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Cannot archive an in-memory session (no session file)");
	const sessionId = ctx.sessionManager.getSessionId();
	const stem = path.basename(sessionFile, ".jsonl");
	const outputPath = args.outputPath ?? `omp-archive-${stem}.zip`;

	// A lazy session's file may not exist yet when /archive is the first turn;
	// serialize the in-memory transcript so both the archive and the viewer work.
	const snapshot = serializeSessionSnapshot(ctx);
	const viewer = args.includeViewer ? await renderViewer(sessionFile, snapshot) : {};
	const viewerHtmlPath = viewer.path;
	try {
		const mainJobs = probeJobs(ctx, ctx.agent.id);
		const liveJobs = {
			main: { agentId: ctx.agent.id, snapshot: mainJobs },
			agents: Object.fromEntries([...agents].map(([id, rec]) => [id, { agentId: id, snapshot: rec.jobs ?? null }])),
		};
		const { zip, manifest } = await buildSessionArchive({
			sessionFile,
			sessionId,
			cwd: ctx.cwd,
			title: ctx.sessionManager.getSessionName(),
			agents: Object.fromEntries(agents),
			liveJobs,
			includeArtifacts: args.includeArtifacts,
			viewerHtmlPath,
			sessionJsonl: snapshot,
			omitted: viewer.error ? [`viewer.html: ${viewer.error}`] : [],
		});
		await Bun.write(outputPath, zip);
		return { outputPath, manifest };
	} finally {
		if (viewerHtmlPath) await fs.rm(viewerHtmlPath, { force: true });
	}
}

/** Serialize the live session manager's header + entries in JSONL form. */
function serializeSessionSnapshot(ctx: ArchiveContext): Uint8Array {
	const lines: string[] = [];
	try {
		const header = ctx.sessionManager.getHeader();
		if (header) lines.push(JSON.stringify(header));
		for (const entry of ctx.sessionManager.getEntries()) lines.push(JSON.stringify(entry));
	} catch {
		// Fall through with whatever was collected.
	}
	return new TextEncoder().encode(lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

function summarize(outputPath: string, manifest: ArchiveManifest): string {
	return [
		`Session archive: ${path.resolve(outputPath)}`,
		`main: ${manifest.main.entries} entries`,
		`subagents: ${manifest.subagents.length}`,
		`artifacts: ${manifest.artifacts.length} files`,
		`total: ${manifest.totals.files} files, ${manifest.totals.bytes} bytes`,
	].join("\n");
}

export default function archiveExtension(pi: ExtensionAPI) {
	// Track the main session and every subagent session this extension is
	// rebound to, plus their background jobs.
	pi.on("session_start", (_event, ctx) => rememberAgent(ctx, { policy: true, jobs: true }));
	pi.on("before_agent_start", (_event, ctx) => rememberAgent(ctx, { policy: true, jobs: true }));
	pi.on("agent_end", (_event, ctx) => rememberAgent(ctx, { jobs: true }));
	pi.on("tool_result", (_event, ctx) => rememberAgent(ctx, { jobs: true }));
	pi.on("session_shutdown", (_event, ctx) => {
		rememberAgent(ctx, { jobs: true });
		const record = agents.get(ctx.agent.id);
		if (record) record.endedAt = Date.now();
	});

	pi.registerCommand("archive", {
		description: "Export the entire session history (main + every subagent + background jobs) as a zip",
		handler: async (args, ctx) => {
			try {
				pi.logger.info(`[archive] start sessionFile=${ctx.sessionManager.getSessionFile() ?? "<none>"} args=${JSON.stringify(args)}`);
				const { outputPath, manifest } = await writeArchive(ctx, parseArchiveArgs(args));
				pi.logger.info(`[archive] wrote ${outputPath} (${manifest.totals.files} files)`);
				ctx.ui.notify(summarize(outputPath, manifest), "info");
			} catch (err) {
				const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
				pi.logger.error(`[archive] failed: ${message}`);
				ctx.ui.notify(`Archive failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "export_session_archive",
		label: "Export session archive",
		description:
			"Write a zip containing the entire history of the current session: the main transcript, every subagent session verbatim (recursively), all untruncated tool/background-job logs, live background-job state, and a standalone HTML viewer.",
		parameters: pi.zod.object({
			outputPath: pi.zod.string().optional(),
			includeArtifacts: pi.zod.boolean().optional(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await writeArchive(ctx, {
				outputPath: params.outputPath,
				includeArtifacts: params.includeArtifacts ?? true,
				includeViewer: true,
			});
			return {
				content: [{ type: "text", text: summarize(result.outputPath, result.manifest) }],
				details: { outputPath: path.resolve(result.outputPath), manifest: result.manifest },
			};
		},
	});
}
