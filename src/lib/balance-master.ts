// ============================================================
// balance-master.ts — Balance Master Stub
// ------------------------------------------------------------
// The Balance Master is the orchestrator that:
//   1. Claims a pending task
//   2. Processes it via LLMProvider (StubProvider by default)
//   3. Saves the result
//   4. Records execution events
//
// This is a STUB — it proves the durable task runtime works.
// It does NOT build a full agent swarm (that's GROUP 01+).
//
// The Master uses the LLMProvider abstraction (ADR-0002):
//   - StubProvider: deterministic canned responses (SIMULATED)
//   - ZaiProvider (future 00-07+): real LLM calls
//
// HONEST CLASSIFICATION:
//   When StubProvider is active, the Master's output is SIMULATED.
//   It does NOT represent real AI reasoning or government recommendation.
// ============================================================
import { getLLMProvider } from "@/lib/llm";
import type { Session } from "next-auth";
import {
  claimTask,
  startTask,
  updateProgress,
  completeTask,
  failTask,
  renewLease,
  getTask,
} from "@/lib/task-service";

const WORKER_ID = `balance-master-${process.pid}-${Date.now()}`;
const LEASE_DURATION_MS = 30_000; // 30s per lease
const PROGRESS_STEPS = [25, 50, 75, 100];

export interface MasterExecuteResult {
  taskId: string;
  status: "completed" | "failed" | "no_task";
  output?: Record<string, unknown>;
  error?: string;
  provider: string;
  simulated: boolean;
}

/**
 * Execute ONE pending task.
 * This is the core Balance Master cycle:
 *   claim → start → process (via LLMProvider) → complete/fail
 *
 * Returns the result. If no task is pending, returns { status: "no_task" }.
 */
export async function executeNextTask(
  session: Session
): Promise<MasterExecuteResult> {
  const provider = getLLMProvider();
  const isSimulated = provider.name === "stub";

  // 1. Claim a pending task
  const claimed = await claimTask(session, WORKER_ID, LEASE_DURATION_MS);
  if (!claimed) {
    return { taskId: "", status: "no_task", provider: provider.name, simulated: isSimulated };
  }

  try {
    // 2. Start the task (claimed → running)
    await startTask(session, claimed.taskId, WORKER_ID);

    // 3. Process via LLMProvider
    // Renew lease before each step to prevent expiry during long processing
    for (const progress of PROGRESS_STEPS) {
      await renewLease(session, claimed.taskId, WORKER_ID, LEASE_DURATION_MS);
      await updateProgress(session, claimed.taskId, progress, WORKER_ID);
    }

    // Call LLM provider to process the task goal
    const llmResult = await provider.complete({
      messages: [
        {
          role: "system",
          content:
            "You are the Balance Master, an orchestrator for state intelligence. " +
            "Process the task goal and provide a structured response. " +
            "Be honest about uncertainty. Do not claim government authority.",
        },
        {
          role: "user",
          content: `Task type: ${claimed.input && typeof claimed.input === "object" && "type" in (claimed.input as Record<string, unknown>) ? (claimed.input as Record<string, unknown>)["type"] : "general"}\nGoal: ${claimed.goal}`,
        },
      ],
      traceId: claimed.taskId,
    });

    // 4. Complete the task with the LLM output
    const output: Record<string, unknown> = {
      response: llmResult.content,
      provider: llmResult.provider,
      model: llmResult.model,
      tokensUsed: llmResult.usage?.totalTokens ?? 0,
      elapsedMs: llmResult.elapsedMs,
      simulated: isSimulated,
    };

    await completeTask(session, claimed.taskId, output, WORKER_ID);

    return {
      taskId: claimed.taskId,
      status: "completed",
      output,
      provider: provider.name,
      simulated: isSimulated,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await failTask(session, claimed.taskId, errorMsg, WORKER_ID);
    return {
      taskId: claimed.taskId,
      status: "failed",
      error: errorMsg,
      provider: provider.name,
      simulated: isSimulated,
    };
  }
}

/**
 * Get the current status of a task (for monitoring).
 */
export async function getTaskStatus(session: Session, taskId: string) {
  return getTask(session, taskId);
}
