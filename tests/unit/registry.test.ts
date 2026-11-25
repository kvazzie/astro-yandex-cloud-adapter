import { afterEach, describe, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";

const command = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => {
	const execFile = () => {};
	Object.defineProperty(
		execFile,
		Symbol.for("nodejs.util.promisify.custom"),
		{ value: command },
	);
	return { execFile };
});

import { npmRegistry } from "../../packages/adapter/src/conditional/FunctionArtifact/Dependency/Registry.ts";

afterEach(() => {
	command.mockReset();
	vi.unstubAllEnvs();
});

function metadata(value: unknown) {
	command.mockResolvedValue({
		stdout: JSON.stringify(value),
		stderr: "",
	});
}

/** Runs npm command expectations under a fixed host platform. */
async function onPlatform<T>(
	value: NodeJS.Platform,
	run: () => Promise<T>,
): Promise<T> {
	const platform = Object.getOwnPropertyDescriptor(
		process,
		"platform",
	)!;
	Object.defineProperty(process, "platform", { value });
	try {
		return await run();
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
}

describe("install registry metadata", () => {
	it.each([
		{
			field: "bundleDependencies",
			value: ["child"],
			expected: ["child"],
		},
		{
			field: "bundledDependencies",
			value: ["child"],
			expected: ["child"],
		},
		{
			field: "bundleDependencies",
			value: true,
			expected: ["child", "optional"],
		},
		{ field: "bundleDependencies", value: false, expected: [] },
	])(
		"retains canonical bundle membership from registry metadata: %j",
		async ({ field, value, expected }) => {
			metadata({
				version: "1.0.0",
				dependencies: { child: "1.0.0" },
				optionalDependencies: { optional: "2.0.0" },
				[field]: value,
			});
			expect(
				(await npmRegistry.resolve("parent", "1.0.0"))
					.bundleDependencies,
			).toEqual(expected);
		},
	);
	it.each([
		{
			name: "generator",
			bin: "./bin/cli.js",
			expected: { generator: "bin/cli.js" },
		},
		{
			name: "@scope/generator",
			bin: "bin/cli.js",
			expected: { generator: "bin/cli.js" },
		},
		{
			name: "generator",
			bin: { generate: "./bin/cli.js", ignored: 42 },
			expected: { generate: "bin/cli.js" },
		},
		{
			name: "generator",
			bin: ["./bin/cli.js", "bin/other.js"],
			expected: {
				"cli.js": "bin/cli.js",
				"other.js": "bin/other.js",
			},
		},
	])(
		"retains npm executable declarations in registry metadata: %j",
		async ({ name, bin, expected }) => {
			metadata({ version: "1.0.0", bin });
			expect(
				(await npmRegistry.resolve(name, "1.0.0")).bin,
			).toEqual(expected);
		},
	);
	it.each([
		{ value: { hasInstallScript: true }, expected: true },
		{
			value: { scripts: { postinstall: "node install.cjs" } },
			expected: true,
		},
		{
			value: { scripts: { prepare: "node build.cjs" } },
			expected: undefined,
		},
	])(
		"preserves registry lifecycle information: %j",
		async ({ value, expected }) => {
			metadata({ version: "1.0.0", ...value });
			expect(
				(await npmRegistry.resolve("example", "1.0.0"))
					.hasInstallScript,
			).toBe(expected);
		},
	);
	it("requests the exact scoped package from npm in the supplied application context", async () => {
		metadata({
			version: "1.0.0",
			peerDependencies: { peer: "^1.0.0" },
			peerDependenciesMeta: { peer: { optional: true } },
		});
		const root = new URL("file:///application/");
		expect(
			await onPlatform("linux", () =>
				npmRegistry.resolve("@scope/pkg", "1.0.0", root),
			),
		).toMatchObject({
			peerDependencies: { peer: "^1.0.0" },
			peerDependenciesMeta: { peer: { optional: true } },
		});
		expect(command).toHaveBeenCalledWith(
			"npm",
			["view", "--json", "--", "@scope/pkg@1.0.0"],
			expect.objectContaining({ cwd: root, timeout: 30_000 }),
		);
	});
	it("pins missing optional package ranges from registry metadata", async () => {
		metadata([
			{ version: "1.0.0" },
			{
				version: "1.2.0",
				os: ["linux"],
				cpu: ["x64"],
				libc: ["glibc"],
			},
			{ version: "2.0.0" },
		]);
		expect(
			await npmRegistry.resolve("native-helper", "^1.0.0"),
		).toMatchObject({
			version: "1.2.0",
			os: ["linux"],
			cpu: ["x64"],
			libc: ["glibc"],
		});
	});
	it("launches the npm CLI with Node and separate arguments on Windows", async () => {
		metadata({ version: "1.0.0" });
		const platform = Object.getOwnPropertyDescriptor(
			process,
			"platform",
		)!;
		const root = new URL("file:///application/");
		vi.stubEnv("npm_execpath", undefined);
		try {
			Object.defineProperty(process, "platform", {
				value: "win32",
			});
			await npmRegistry.resolve("@scope/package", "1.0.0", root);
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
		expect(command).toHaveBeenCalledWith(
			process.execPath,
			[
				join(
					dirname(process.execPath),
					"node_modules",
					"npm",
					"bin",
					"npm-cli.js",
				),
				"view",
				"--json",
				"--",
				"@scope/package@1.0.0",
			],
			expect.objectContaining({ cwd: root, timeout: 30_000 }),
		);
	});
	it("bounds registry requests and excludes npm private diagnostics from errors", async () => {
		command.mockRejectedValue(
			new Error("npm private fixture-token diagnostics"),
		);
		await expect(
			onPlatform("linux", () =>
				npmRegistry.resolve("stalled-package", "1.0.0"),
			),
		).rejects.toMatchObject({
			message:
				'The "install" dependency strategy cannot resolve the runtime package "stalled-package@1.0.0" from the configured npm registry. Check npm configuration and network access and try again.',
		});
		expect(command).toHaveBeenCalledWith(
			"npm",
			expect.any(Array),
			expect.objectContaining({ timeout: 30_000 }),
		);
	});
});
