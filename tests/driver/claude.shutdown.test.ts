import { describe, it, expect } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';

/**
 * Verifies the orphan-cleanup contract: a long-running tracked child receives
 * SIGTERM (and SIGKILL on grace expiry) when shutdown() is called. We use a
 * tiny ad-hoc driver that spawns `sleep` so we don't need a real claude binary.
 */
class SleepDriver {
  readonly name = 'sleep';
  readonly inFlight = new Set<ChildProcess>();

  spawnSleep(seconds: number): ChildProcess {
    const child = spawn('sleep', [String(seconds)], { stdio: 'ignore' });
    this.inFlight.add(child);
    child.on('close', () => this.inFlight.delete(child));
    child.on('error', () => this.inFlight.delete(child));
    return child;
  }

  async shutdown(timeoutMs = 2000): Promise<void> {
    if (this.inFlight.size === 0) return;
    for (const child of this.inFlight) {
      try { child.kill('SIGTERM'); } catch {}
    }
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const child of this.inFlight) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }
}

describe('orphan child cleanup contract', () => {
  it('SIGTERMs and clears in-flight children on shutdown()', async () => {
    const driver = new SleepDriver();
    const child = driver.spawnSleep(60);
    expect(driver.inFlight.size).toBe(1);
    expect(child.killed).toBe(false);

    await driver.shutdown(2000);

    // After shutdown, the child should have exited (either via SIGTERM or SIGKILL).
    // The set should be empty because the close handler runs when the child exits.
    expect(driver.inFlight.size).toBe(0);
  });

  it('shutdown() is a no-op when no children are in-flight', async () => {
    const driver = new SleepDriver();
    await driver.shutdown(100);
    expect(driver.inFlight.size).toBe(0);
  });

  it('handles multiple in-flight children', async () => {
    const driver = new SleepDriver();
    driver.spawnSleep(60);
    driver.spawnSleep(60);
    driver.spawnSleep(60);
    expect(driver.inFlight.size).toBe(3);

    await driver.shutdown(2000);
    expect(driver.inFlight.size).toBe(0);
  });
});
