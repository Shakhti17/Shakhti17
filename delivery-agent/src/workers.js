// Pattern 4 - Orchestrator / workers.
// Each worker has a narrow role, its own small tool set and its own context
// window: it sees the brief, its one subtask and only the outputs of the tasks
// it depends on. That keeps workers focused and stops context pollution.
import { runToolAgent } from "./llm.js";

const SHARED = `You are one specialist on an AI project-delivery team led by an orchestrator.
Do only your assigned subtask. Ground every claim in the brief, the inputs you were
given, or tool results; when you must assume something, label it "Assumption:".
Reply in concise Markdown that the orchestrator can paste into a delivery plan.`;

export const WORKERS = {
  scope_analyst: {
    description: "Scope, deliverables, work breakdown structure (WBS), acceptance criteria, out-of-scope items.",
    tools: ["read_project_file", "recall_memory", "save_memory"],
    system: `${SHARED}
Role: scope analyst. Produce a work breakdown structure with phases and work
packages, each with a short id (e.g. P1.2), an estimate in working days and its
dependencies. List deliverables, acceptance criteria and what is out of scope.`,
  },
  scheduler: {
    description: "Timeline, milestones and critical path, computed from the WBS with the compute_schedule tool.",
    tools: ["compute_schedule", "recall_memory"],
    system: `${SHARED}
Role: scheduler. Turn the work packages you are given into a schedule by calling
compute_schedule; never do date arithmetic yourself. Report milestones, the
critical path, total duration and where a week of slip would hurt most.`,
  },
  risk_analyst: {
    description: "Risk register: identify risks, score them with score_risks, propose mitigations and owners.",
    tools: ["score_risks", "recall_memory", "web_search"],
    system: `${SHARED}
Role: risk analyst. Identify delivery, technical, security, people and vendor
risks. Score every risk with the score_risks tool and present the ranked
register as a table with mitigation and owner.`,
  },
  stakeholder_analyst: {
    description: "Stakeholder map, RACI matrix, communication and governance plan.",
    tools: ["read_project_file", "recall_memory", "save_memory"],
    system: `${SHARED}
Role: stakeholder analyst. Map stakeholders by influence and interest, build a
RACI for the main deliverables, and propose a communication cadence and
governance (steering committee, decision rights, escalation path).`,
  },
};

export async function runWorker({ task, brief, inputs, tools, memoryNotes }) {
  const worker = WORKERS[task.worker];
  const available = worker.tools.map((name) => tools[name]).filter(Boolean);
  const inputText = inputs.length
    ? inputs.map((i) => `### Output of ${i.id} (${i.title})\n${i.output}`).join("\n\n")
    : "(none)";

  return runToolAgent({
    name: `${task.worker}:${task.id}`,
    system: worker.system,
    tools: available,
    prompt: `<brief>\n${brief}\n</brief>

<relevant_memory>\n${memoryNotes || "(none)"}\n</relevant_memory>

<inputs_from_other_workers>\n${inputText}\n</inputs_from_other_workers>

Your subtask (${task.id}): ${task.title}
${task.instructions}`,
  });
}
