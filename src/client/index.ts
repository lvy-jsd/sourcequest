import type { CapabilityEntry } from "../ports/index.js";
import type { PolicySettings } from "../adapters/dsh-rpc.js";
import type { DoctorReport } from "../adapters/dsh-doctor.js";

export type PanelSlotId = "sources" | "policy" | "tasks" | "evidence";

export type SourceQuestUiSnapshot = {
  policyRevision: string;
  policy: PolicySettings;
  sources: readonly CapabilityEntry[];
  tasks: readonly { taskId: string; status: string; revision: number }[];
  evidencePreview?: { snapshotHash: string; quote: string; length: number };
  doctor?: DoctorReport;
};

export const SOURCEQUEST_UI_SLOTS: readonly { id: PanelSlotId; title: string; route: string }[] = [
  { id: "sources", title: "SourceQuest Sources & Capabilities", route: "/plugins/sourcequest/sources" },
  { id: "policy", title: "SourceQuest Routing & Budget Policy", route: "/plugins/sourcequest/policy" },
  { id: "tasks", title: "SourceQuest Tasks & Jobs", route: "/plugins/sourcequest/tasks" },
  { id: "evidence", title: "SourceQuest Evidence & Citations", route: "/plugins/sourcequest/evidence" },
];

function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderSourceQuestPanelHtml(snapshot: SourceQuestUiSnapshot): string {
  const sourceRows = snapshot.sources
    .map(
      (s) =>
        `<tr data-capability-id="${escapeHtml(s.id)}"><td>${escapeHtml(s.id)}</td><td>${escapeHtml(s.kind)}</td><td>${s.enabled ? "enabled" : "disabled"}</td><td>${escapeHtml(s.supportStatus)}</td><td>${escapeHtml(s.billing)}</td></tr>`,
    )
    .join("");
  const taskRows = snapshot.tasks
    .map(
      (t) =>
        `<tr data-task-id="${escapeHtml(t.taskId)}"><td>${escapeHtml(t.taskId.slice(0, 12))}</td><td>${escapeHtml(t.status)}</td><td>rev ${t.revision}</td></tr>`,
    )
    .join("");

  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><title>SourceQuest Panel</title>',
    "<style>body{font-family:system-ui,sans-serif;margin:1.5rem;color:#111}section{margin-bottom:1.5rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}</style>",
    "</head><body>",
    "<h1>SourceQuest Native Control Panel</h1>",
    `<section id="panel-policy" data-slot="policy" data-revision="${snapshot.policy.revision}">`,
    `<h2>Policy (rev ${snapshot.policy.revision} / ${escapeHtml(snapshot.policyRevision)})</h2>`,
    `<p>Strategy: ${escapeHtml(snapshot.policy.defaultStrategy)} | Fallback: ${snapshot.policy.allowFallback} | StrictCostCap: ${snapshot.policy.strictCostCap}</p>`,
    "</section>",
    '<section id="panel-sources" data-slot="sources">',
    "<h2>Sources & Executors</h2>",
    `<table><thead><tr><th>ID</th><th>Kind</th><th>State</th><th>Support</th><th>Billing</th></tr></thead><tbody>${sourceRows}</tbody></table>`,
    "</section>",
    '<section id="panel-tasks" data-slot="tasks">',
    "<h2>Tasks</h2>",
    `<table><thead><tr><th>Task</th><th>Status</th><th>Revision</th></tr></thead><tbody>${taskRows}</tbody></table>`,
    "</section>",
    '<section id="panel-evidence" data-slot="evidence">',
    "<h2>Evidence</h2>",
    snapshot.evidencePreview
      ? `<pre data-hash="${escapeHtml(snapshot.evidencePreview.snapshotHash)}">${escapeHtml(snapshot.evidencePreview.quote)}</pre>`
      : "<p>No snapshot selected.</p>",
    "</section>",
    "</body></html>",
  ].join("\n");
}
