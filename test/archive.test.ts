import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSessionArchive } from "../extensions/archive-core";
import { createZip } from "../extensions/zip";

function tmpdir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function unzip(zipPath: string, dest: string): void {
	const result = spawnSync("unzip", ["-q", "-o", zipPath, "-d", dest], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`unzip failed: ${result.stderr || result.stdout}`);
}

test("createZip round-trips entries through unzip", () => {
	const dir = tmpdir("omp-archive-zip-");
	const zipPath = path.join(dir, "out.zip");
	const encoder = new TextEncoder();
	const payload = encoder.encode("hello, background job\n".repeat(50));
	fs.writeFileSync(
		zipPath,
		createZip([
			{ name: "a.txt", data: encoder.encode("alpha") },
			{ name: "nested/b.log", data: payload },
		]),
	);
	unzip(zipPath, dir);
	expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("alpha");
	expect(fs.readFileSync(path.join(dir, "nested/b.log"), "utf8")).toBe(new TextDecoder().decode(payload));
});

test("buildSessionArchive captures main, subagents, artifacts, and jobs", async () => {
	const root = tmpdir("omp-archive-core-");
	const sessionFile = path.join(root, "sessions", "-tmp", "2026-01-01T00-00-00-000Z_abc.jsonl");
	const artifactDir = sessionFile.slice(0, -".jsonl".length);
	fs.mkdirSync(path.join(artifactDir, "Sub"), { recursive: true });

	const lines = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ id: `${i}`, type: "message" })).join("\n") + "\n";
	const asyncResult = JSON.stringify({
		type: "custom_message",
		customType: "async-result",
		id: "jobentry1",
		timestamp: "2026-01-01T00:00:01.000Z",
		content:
			'<system-notice>\nBackground job BuildEnv has completed. Resume your work using the result below.\n<task-result id="BuildEnv" agent="scout" status="completed" duration="1m02s">\n<meta lines="12" size="3.4KB" />\n<preview full-output="agent://BuildEnv">',
	});
	fs.writeFileSync(sessionFile, lines(3) + asyncResult + "\n");
	fs.writeFileSync(path.join(artifactDir, "Sub.jsonl"), lines(4));
	fs.writeFileSync(path.join(artifactDir, "Sub", "Child.jsonl"), lines(2));
	fs.writeFileSync(path.join(artifactDir, "Sub.jsonl.tombstone"), "");
	fs.writeFileSync(path.join(artifactDir, "12.bash.log"), "full untruncated output\n");

	const { zip, manifest } = await buildSessionArchive({
		sessionFile,
		sessionId: "abc",
		cwd: "/tmp",
		includeArtifacts: true,
		liveJobs: { main: { snapshot: { running: [], recent: [] } } },
		now: new Date("2026-01-01T00:00:00Z"),
	});

	expect(manifest.main.entries).toBe(4);
	expect(manifest.subagents.map(s => s.key)).toEqual(["Sub", "Sub/Child"]);
	expect(manifest.subagents.find(s => s.key === "Sub")?.aborted).toBe(true);
	expect(manifest.artifacts.map(a => a.file)).toContain("artifacts/12.bash.log");
	expect(manifest.artifacts.map(a => a.file)).toContain("artifacts/Sub.jsonl");
	const jobs = manifest.jobs as {
		completed: number;
		completedJobs: { agent: string; label: string; status: string; duration: string }[];
	};
	expect(jobs.completed).toBe(1);
	expect(jobs.completedJobs[0]).toMatchObject({ agent: "main", label: "BuildEnv", status: "completed", duration: "1m02s" });

	const zipPath = path.join(root, "archive.zip");
	fs.writeFileSync(zipPath, zip);
	const dest = path.join(root, "extracted");
	unzip(zipPath, dest);

	expect(fs.readFileSync(path.join(dest, "session.jsonl"), "utf8")).toBe(lines(3) + asyncResult + "\n");
	expect(fs.readFileSync(path.join(dest, "artifacts/Sub/Child.jsonl"), "utf8")).toBe(lines(2));
	expect(fs.readFileSync(path.join(dest, "artifacts/12.bash.log"), "utf8")).toBe("full untruncated output\n");
	const written = JSON.parse(fs.readFileSync(path.join(dest, "manifest.json"), "utf8"));
	expect(written.format).toBe("omp-session-archive/v1");
	expect(written.subagents.length).toBe(2);
});
