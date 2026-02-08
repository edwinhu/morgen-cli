import { describe, it, expect } from "bun:test";
import { resolve, dirname } from "path";

describe("morgen CLI", () => {
  const CLI = resolve(dirname(import.meta.path), "..", "cli.ts");

  it("shows help with --help", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("Morgen CLI");
    expect(stdout).toContain("COMMANDS");
    expect(stdout).toContain("tasks");
  });

  it("shows version with --version", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "--version"], {
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("shows help with no args", async () => {
    const proc = Bun.spawn(["bun", "run", CLI], {
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("Morgen CLI");
  });

  it("shows error for unknown command", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "nonexistent"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown command");
  });

  it("tasks command fails without any auth", async () => {
    // Bun auto-loads .env, so we need a tmpdir without one
    // Also override HOME to prevent session-based auth
    const tmpdir = (await import("os")).tmpdir();
    const env = { ...process.env, MORGEN_API_KEY: "", HOME: "/tmp/morgen-test-no-auth" };

    const proc = Bun.spawn(["bun", "run", CLI, "tasks"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
      cwd: tmpdir,
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("authentication");
  });

  it("help shows auth and accounts commands", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "--help"], {
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("auth");
    expect(stdout).toContain("accounts");
    expect(stdout).toContain("--all");
    expect(stdout).toContain("--account");
    expect(stdout).toContain("MORGEN_API_KEY");
  });

  it("tasks create requires --title", async () => {
    const env = { ...process.env, MORGEN_API_KEY: "test-key" };

    const proc = Bun.spawn(["bun", "run", CLI, "tasks", "create"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--title");
  });

  it("help text includes chat command", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("chat");
  });

  it("chat command without prompt shows error", async () => {
    const env = { ...process.env, MORGEN_API_KEY: "test-key" };

    const proc = Bun.spawn(["bun", "run", CLI, "chat"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("prompt");
  });

  it("chat command without session token shows auth error", async () => {
    // Ensure no session file exists by using a non-existent config dir
    const env = {
      ...process.env,
      MORGEN_API_KEY: "test-key",
      HOME: "/tmp/morgen-cli-test-nonexistent",
    };

    const proc = Bun.spawn(["bun", "run", CLI, "chat", "hello"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("auth");
  });
});
