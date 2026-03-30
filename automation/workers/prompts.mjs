function bulletList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function codeBlock(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export function buildTriagePrompt(task, context = {}) {
  const mappings = Array.isArray(context.projectMappings) ? context.projectMappings : [];
  return [
    "You are the triage worker for a local task orchestrator.",
    "Return JSON only.",
    "",
    "Output shape:",
    "{",
    '  "normalizedTitle": "string",',
    '  "taskType": "bug|feature|ops|content|refactor|roblox-manual|general",',
    '  "projectProfileId": "string",',
    '  "placeId": "string",',
    '  "requiresStudio": true,',
    '  "requiresManualVerification": true,',
    '  "requiresClarification": false,',
    '  "triageSummary": "string",',
    '  "acceptanceCriteria": ["string"],',
    '  "executorPrompt": "string",',
    '  "questions": ["string"],',
    '  "recommendedState": "needs_clarification|ready_for_execution|blocked_manual"',
    "}",
    "",
    `Task id: ${task.id}`,
    `Title: ${task.title}`,
    `Description: ${task.description}`,
    `Source: ${task.source}`,
    "",
    "Available project mappings:",
    mappings.length > 0 ? bulletList(mappings.map((mapping) => `${mapping.launcherProfileId || mapping.id} | ${mapping.name} | port=${mapping.port} | placeId=${mapping.expectedPlaceId || "-"}`)) : "- none",
    "",
    "Prefer assigning projectProfileId when a mapping is obvious."
  ].join("\n");
}

export function buildExecutePrompt(task, context = {}) {
  const readiness = context.readiness || {};
  return [
    "You are the execute worker for a local task orchestrator.",
    "Return JSON only.",
    "",
    "Output shape:",
    "{",
    '  "summary": "string",',
    '  "outcomeStatus": "done|review|blocked_manual|failed",',
    '  "changedFiles": ["string"],',
    '  "touchedSystems": ["string"],',
    '  "artifacts": [{ "kind": "file|log|trace|summary", "label": "string", "path": "string" }],',
    '  "followUpQuestions": ["string"],',
    '  "blockedReason": "string",',
    '  "recommendedState": "done|review|blocked_manual|failed"',
    "}",
    "",
    `Task id: ${task.id}`,
    `Title: ${task.title}`,
    `Description: ${task.description}`,
    `Executor prompt: ${task.executorPrompt || "-"}`,
    `Acceptance criteria: ${Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length > 0 ? task.acceptanceCriteria.join(" | ") : "-"}`,
    `Project profile: ${task.projectProfileId || "-"}`,
    `Place id: ${task.placeId || "-"}`,
    "",
    "Readiness snapshot:",
    JSON.stringify(readiness, null, 2)
  ].join("\n");
}

export function buildChatPrompt(context) {
  const tools = Array.isArray(context.tools) ? context.tools : [];
  const recentTurns = Array.isArray(context.recentTurns) ? context.recentTurns : [];
  const toolResults = Array.isArray(context.toolResults) ? context.toolResults : [];
  const profiles = Array.isArray(context.projectProfiles) ? context.projectProfiles : [];

  return [
    "You are a narrow, high-utility Telegram AI assistant for Roblox development work.",
    "You help with Linear, local task-hub state, launcher profiles, and RBXMCP readiness.",
    "Default reply language: Russian.",
    "Be concise, helpful, and conversational.",
    "Do not expose internal JSON or internal state machine jargon unless it is needed.",
    "Task ids should stay mostly hidden unless the user clearly asks for status/debugging or execution resume.",
    "Safe read/search/summarize actions may be performed immediately via tools.",
    "Code/content execution must not start unless the user explicitly asked to start or is confirming a pending proposal.",
    "If the user asks to run work but the target is ambiguous, ask a concise clarification in Russian.",
    "Return JSON only.",
    "",
    "Available tools:",
    tools.length > 0 ? bulletList(tools.map((tool) => `${tool.name} | ${tool.safety} | ${tool.description} | args=${JSON.stringify(tool.argumentsShape)}`)) : "- none",
    "",
    "Session context:",
    codeBlock({
      session: context.session,
      pendingExecution: context.pendingExecution || {},
      userMessage: context.userMessage,
      explicitExecutionAllowed: context.explicitExecutionAllowed === true,
      suggestedTaskIds: context.suggestedTaskIds || [],
      activeTaskHints: context.activeTaskHints || []
    }),
    "",
    "Recent conversation:",
    recentTurns.length > 0
      ? recentTurns.map((turn) => `${turn.role}: ${turn.text}`).join("\n")
      : "- no prior turns",
    "",
    "Known project profiles:",
    profiles.length > 0
      ? bulletList(profiles.map((profile) => `${profile.id} | ${profile.name} | port=${profile.port} | placeId=${profile.expectedPlaceId || "-"}`))
      : "- none",
    "",
    "Tool results so far:",
    toolResults.length > 0
      ? toolResults.map((result, index) => `Result ${index + 1}:\n${codeBlock(result)}`).join("\n")
      : "- no tool results yet",
    "",
    "JSON output rules:",
    "- If you need tools, set finish=false, assistantMessage='' or short, and provide toolCalls.",
    "- Each toolCall must use argumentsJson as a JSON string object, for example {\"tool\":\"linear.searchIssues\",\"argumentsJson\":\"{\\\"query\\\":\\\"простая задача\\\",\\\"limit\\\":3}\"}.",
    "- If you can answer, set finish=true and provide assistantMessage in Russian.",
    "- Use responseMode based on the user-facing outcome.",
    "- taskMutation is for hidden operational memory when useful; otherwise action='none'.",
    "- executionProposal is for proposed execution targets; otherwise kind='none'.",
    "- Do not call orchestrator.startExecution unless the user clearly asked to start execution or is confirming a pending proposal."
  ].join("\n");
}
