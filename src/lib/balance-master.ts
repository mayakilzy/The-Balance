// ============================================================
// balance-master.ts — Balance Master Stub (Integrity Closure)
// ------------------------------------------------------------
// Updated to pass claimGeneration through all task operations.
// Fencing prevents stale workers from overwriting results.
//
// HONEST CLASSIFICATION:
//   When StubProvider is active, the Master's output is SIMULATED.
// ============================================================
import { getLLMProvider, type LLMProvider } from "@/lib/llm";
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
const LEASE_DURATION_MS = 30_000;
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
 * Execute ONE pending task using a specific LLM provider.
 * The provider is injected so tests can inject failures.
 */
export async function executeNextTaskWithProvider(
  session: Session,
  provider: LLMProvider
): Promise<MasterExecuteResult> {
  const isSimulated = provider.name === "stub";

  // 1. Claim a pending task (includes claimGeneration fencing token)
  const claimed = await claimTask(session, WORKER_ID, LEASE_DURATION_MS);
  if (!claimed) {
    return { taskId: "", status: "no_task", provider: provider.name, simulated: isSimulated };
  }

  const { taskId, goal, claimGeneration } = claimed;

  try {
    // 2. Start the task (fenced by claimGeneration)
    await startTask(session, taskId, WORKER_ID, claimGeneration);

    // 3. Process via LLMProvider
    for (const progress of PROGRESS_STEPS) {
      await renewLease(session, taskId, WORKER_ID, claimGeneration, LEASE_DURATION_MS);
      await updateProgress(session, taskId, progress, WORKER_ID, claimGeneration);
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
          content: `Goal: ${goal}`,
        },
      ],
      traceId: taskId,
    });

    // 4. Complete the task (fenced by claimGeneration)
    const output: Record<string, unknown> = {
      response: llmResult.content,
      provider: llmResult.provider,
      model: llmResult.model,
      tokensUsed: llmResult.usage?.totalTokens ?? 0,
      elapsedMs: llmResult.elapsedMs,
      simulated: isSimulated,
    };

    await completeTask(session, taskId, output, WORKER_ID, claimGeneration);

    return {
      taskId,
      status: "completed",
      output,
      provider: provider.name,
      simulated: isSimulated,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Fail the task (fenced by claimGeneration — if claim was lost, this also fails,
    // which is correct: we don't want a stale worker recording a failure either)
    try {
      await failTask(session, taskId, errorMsg, WORKER_ID, claimGeneration);
    } catch {
      // If fencing rejects the fail (claim lost), the error is already logged
      // by the reclaim process. We don't suppress it — we just don't duplicate.
    }
    return {
      taskId,
      status: "failed",
      error: errorMsg,
      provider: provider.name,
      simulated: isSimulated,
    };
  }
}

/**
 * Execute ONE pending task using the default LLM provider.
 */
export async function executeNextTask(
  session: Session
): Promise<MasterExecuteResult> {
  return executeNextTaskWithProvider(session, getLLMProvider());
}

/**
 * Get the current status of a task.
 */
export async function getTaskStatus(session: Session, taskId: string) {
  return getTask(session, taskId);
}
