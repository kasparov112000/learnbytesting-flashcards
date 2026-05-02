import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';

/**
 * Code Runner Service
 * ===================
 * Runs learner-submitted code against a card's testCases in a constrained
 * subprocess and returns per-test results.
 *
 * Phase 1 limitations (issue #185):
 *   - Python only. `language` is plumbed for future expansion.
 *   - 'output-match' strategy only — stdout (trimmed) vs expectedOutput.
 *   - Hard wall-clock timeout per test case.
 *   - Python is invoked with `-I` (isolated mode): ignores PYTHON* env vars and
 *     does not add the user's site-packages or CWD to sys.path. Reduces import
 *     surface and prevents trivial env-var leaks.
 *
 * NOT YET ENFORCED (tracked as Phase 1.5 follow-ups):
 *   - Network blocking (requires netns / runner pod with `network: none`)
 *   - Filesystem restriction (requires chroot / read-only mount)
 *   - Memory / CPU caps (requires cgroups or container-per-run)
 *
 * Surface area note: this service spawns child processes and writes temp files
 * under os.tmpdir(). It MUST never be exposed to unauthenticated callers. The
 * route handler is expected to authenticate the request via the orchestrator's
 * Bearer-token middleware (same as all other flashcards endpoints).
 */

// Hard ceiling regardless of card config. Prevents abusive cards from pinning a
// runner thread for minutes.
const MAX_TIMEOUT_MS = 10000;

// Per-test stdout/stderr cap. Anything beyond this is truncated. Prevents an
// infinite-print loop from filling memory before the timeout fires.
const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KB

// Python interpreter binary. Configurable so K8s images and local dev can both
// succeed (CLAUDE.md: this Windows machine uses `python` not `python3`).
const PYTHON_BIN = process.env.CODE_RUNNER_PYTHON_BIN
  || (process.platform === 'win32' ? 'python' : 'python3');

export interface TestCase {
  description?: string;
  input?: string;
  expectedOutput: string;
  hidden?: boolean;
}

export interface TestResult {
  // Index in the original testCases array (preserved across hidden filtering)
  index: number;
  description?: string;
  passed: boolean;
  // Truncated to MAX_OUTPUT_BYTES
  stdout: string;
  stderr: string;
  // 'pass' | 'fail' | 'timeout' | 'crash' | 'error'
  status: 'pass' | 'fail' | 'timeout' | 'crash' | 'error';
  // Wall-clock duration of THIS test case in ms (rounded)
  durationMs: number;
  // For 'fail' results, the (trimmed) expected vs actual to surface in the UI.
  // Suppressed when hidden=true so learners can't probe hidden cases.
  expected?: string;
  actual?: string;
}

export interface RunCodeRequest {
  code: string;
  testCases: TestCase[];
  language?: string; // 'python' is the only supported value in Phase 1
  checkStrategy?: 'output-match' | 'unit-tests' | 'ast-match';
  timeoutMs?: number;
}

export interface RunCodeResult {
  // True iff EVERY test case passed. Matches what the FSRS reviewer cares about.
  passed: boolean;
  // Per-test breakdown. Hidden tests have stdout/expected/actual stripped.
  results: TestResult[];
  // Aggregate counters for quick UI summary
  passedCount: number;
  failedCount: number;
  totalCount: number;
  // Total wall-clock time spent running all tests (sum of per-test durations)
  totalDurationMs: number;
}

/**
 * Run a single python subprocess with the given code + stdin and capture
 * stdout/stderr under a hard timeout. Cleans up the temp file in finally.
 */
async function runPythonOnce(
  code: string,
  stdin: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; timedOut: boolean; exitCode: number | null; durationMs: number }> {
  // Random temp filename so concurrent submissions don't collide
  const tmpFile = path.join(os.tmpdir(), `lbt-runner-${randomBytes(8).toString('hex')}.py`);
  fs.writeFileSync(tmpFile, code, 'utf-8');

  const started = Date.now();

  return new Promise((resolve) => {
    // -I: isolated mode (no PYTHON* env, no user site-packages, no CWD on sys.path)
    // -B: don't write .pyc files (no FS pollution)
    const proc = spawn(PYTHON_BIN, ['-I', '-B', tmpFile], {
      // Empty env reduces leakage of secrets/PATH manipulation. PATH is still
      // set so the interpreter can find its own stdlib.
      env: { PATH: process.env.PATH || '' },
      timeout: timeoutMs,
      windowsHide: true
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;

    // Cap output buffers — kill the process if a test floods stdout
    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout = Buffer.concat([stdout, chunk]).slice(0, MAX_OUTPUT_BYTES);
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr = Buffer.concat([stderr, chunk]).slice(0, MAX_OUTPUT_BYTES);
      }
    });

    // Node's `timeout` option sends SIGTERM at the timer; track that here so we
    // can distinguish a timeout from a normal nonzero exit.
    proc.on('error', (err: any) => {
      // ENOENT => python binary missing; surface as stderr so the API caller
      // sees a useful message rather than a silent crash
      stderr = Buffer.concat([stderr, Buffer.from(`[runner] spawn error: ${err.message}\n`)]);
    });

    proc.on('close', (code, signal) => {
      // Cleanup temp file — best-effort, ignore errors
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      // SIGTERM from Node's timeout option => timed out
      if (signal === 'SIGTERM' && (Date.now() - started) >= timeoutMs - 50) {
        timedOut = true;
      }
      resolve({
        stdout: stdout.toString('utf-8'),
        stderr: stderr.toString('utf-8'),
        timedOut,
        exitCode: code,
        durationMs: Date.now() - started
      });
    });

    // Write stdin and close — many programs read all of stdin before processing
    if (stdin && stdin.length > 0) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  });
}

export class CodeRunnerService {
  /**
   * Run a learner submission against the given test cases.
   * Defensive about every input — this is the trust boundary between user
   * code and our process.
   */
  async run(req: RunCodeRequest): Promise<RunCodeResult> {
    const language = (req.language || 'python').toLowerCase();
    const strategy = req.checkStrategy || 'output-match';
    // Clamp the timeout so a malicious card can't pin a runner for minutes
    const timeoutMs = Math.min(Math.max(req.timeoutMs || 5000, 100), MAX_TIMEOUT_MS);

    // Phase 1: only python + output-match are implemented. Fail fast for
    // anything else so the UI can show a clear error instead of a silent pass.
    if (language !== 'python') {
      return this.errorResult(req.testCases, `Language '${language}' is not supported in Phase 1 (python only)`);
    }
    if (strategy !== 'output-match') {
      return this.errorResult(req.testCases, `checkStrategy '${strategy}' is not implemented yet`);
    }
    if (!req.code || typeof req.code !== 'string') {
      return this.errorResult(req.testCases, 'Submitted code is empty');
    }
    if (!Array.isArray(req.testCases) || req.testCases.length === 0) {
      return this.errorResult([], 'No test cases on this card — cannot grade submission');
    }

    const results: TestResult[] = [];
    let totalDuration = 0;

    // Run sequentially. Parallel runs would let one slow test mask another and
    // would multiply the worst-case load on the host. Sequential keeps the
    // runner's resource footprint predictable.
    for (let i = 0; i < req.testCases.length; i++) {
      const tc = req.testCases[i];
      const expected = (tc.expectedOutput || '').trim();
      const stdinPayload = tc.input || '';

      let exec;
      try {
        exec = await runPythonOnce(req.code, stdinPayload, timeoutMs);
      } catch (err: any) {
        // Should never throw (runPythonOnce always resolves) but be defensive
        results.push({
          index: i,
          description: tc.description,
          passed: false,
          stdout: '',
          stderr: String(err?.message || err),
          status: 'error',
          durationMs: 0
        });
        continue;
      }

      totalDuration += exec.durationMs;
      const actual = exec.stdout.trim();

      // Decide outcome status. Order matters: timeout > crash > fail > pass.
      let status: TestResult['status'];
      let passed = false;
      if (exec.timedOut) {
        status = 'timeout';
      } else if (exec.exitCode !== 0 && actual === '' && exec.stderr.length > 0) {
        // Nonzero exit + stderr output => python crashed (e.g. SyntaxError)
        status = 'crash';
      } else if (actual === expected) {
        status = 'pass';
        passed = true;
      } else {
        status = 'fail';
      }

      // Hidden tests: don't leak stdout/expected so learners can't reverse the
      // hidden case from successive submissions.
      const hide = !!tc.hidden;
      results.push({
        index: i,
        description: hide ? undefined : tc.description,
        passed,
        stdout: hide ? '' : exec.stdout,
        stderr: hide ? '' : exec.stderr,
        status,
        durationMs: Math.round(exec.durationMs),
        expected: hide ? undefined : expected,
        actual: hide ? undefined : actual
      });
    }

    const passedCount = results.filter(r => r.passed).length;
    return {
      passed: passedCount === results.length && results.length > 0,
      results,
      passedCount,
      failedCount: results.length - passedCount,
      totalCount: results.length,
      totalDurationMs: totalDuration
    };
  }

  /**
   * Build a uniformly-failing result set when we reject the request before
   * running anything. Keeps the caller's response shape stable.
   */
  private errorResult(testCases: TestCase[], message: string): RunCodeResult {
    const results: TestResult[] = (testCases || []).map((tc, i) => ({
      index: i,
      description: tc.description,
      passed: false,
      stdout: '',
      stderr: message,
      status: 'error' as const,
      durationMs: 0
    }));
    return {
      passed: false,
      results,
      passedCount: 0,
      failedCount: results.length,
      totalCount: results.length,
      totalDurationMs: 0
    };
  }
}
