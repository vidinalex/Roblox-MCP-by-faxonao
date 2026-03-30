import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { bootstrapAutomationDatabase } from "./db.mjs";

export const taskStates = [
  "new",
  "needs_triage",
  "needs_clarification",
  "ready_for_execution",
  "blocked_manual",
  "executing",
  "review",
  "done",
  "failed",
  "cancelled"
];

function nowIso() {
  return new Date().toISOString();
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return fallback;
  }
}

function asBoolean(value) {
  return value === 1 || value === true;
}

function serializeTask(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    source: row.source,
    sourceRef: row.source_ref,
    title: row.title,
    description: row.description,
    projectProfileId: row.project_profile_id || "",
    placeId: row.place_id || "",
    conversationKey: row.conversation_key || "",
    intentType: row.intent_type || "general",
    visibility: row.visibility || "normal",
    state: row.state,
    taskType: row.task_type,
    requiresStudio: asBoolean(row.requires_studio),
    requiresManualVerification: asBoolean(row.requires_manual_verification),
    requiresClarification: asBoolean(row.requires_clarification),
    acceptanceCriteria: parseJson(row.acceptance_criteria_json, []),
    executorPrompt: row.executor_prompt || "",
    blockedReason: row.blocked_reason || "",
    triageSummary: row.triage_summary || "",
    executionSummary: row.execution_summary || "",
    sourceContext: parseJson(row.source_context_json, {}),
    lastAgentAction: row.last_agent_action || "",
    lastUserGoal: row.last_user_goal || "",
    executionPendingConfirmation: asBoolean(row.execution_pending_confirmation),
    lastOperatorMessageAt: row.last_operator_message_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeMessage(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    source: row.source,
    direction: row.direction,
    messageType: row.message_type,
    body: row.body,
    meta: parseJson(row.meta_json, {}),
    createdAt: row.created_at
  };
}

function serializeQuestion(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    question: row.question,
    status: row.status,
    answer: row.answer,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeRun(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    mode: row.mode,
    status: row.status,
    runtime: row.runtime,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary: row.summary,
    input: parseJson(row.input_json, {}),
    output: parseJson(row.output_json, {}),
    error: parseJson(row.error_json, {})
  };
}

function serializeArtifact(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind,
    label: row.label,
    path: row.path,
    meta: parseJson(row.meta_json, {}),
    createdAt: row.created_at
  };
}

function serializeLink(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    linkType: row.link_type,
    externalId: row.external_id,
    externalUrl: row.external_url,
    meta: parseJson(row.meta_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeProjectProfile(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    workspacePath: row.workspace_path,
    port: row.port,
    expectedPlaceId: row.expected_place_id,
    wslWorkspacePath: row.wsl_workspace_path,
    favorite: asBoolean(row.favorite),
    lastSeenAt: row.last_seen_at,
    source: parseJson(row.source_json, {})
  };
}

function serializeChatSession(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    channel: row.channel,
    externalId: row.external_id,
    conversationKey: row.conversation_key,
    lastTaskId: row.last_task_id || "",
    lastUserGoal: row.last_user_goal || "",
    lastAgentAction: row.last_agent_action || "",
    pendingExecution: parseJson(row.pending_execution_json, {}),
    lastSuggestions: parseJson(row.last_suggestions_json, []),
    sourceContext: parseJson(row.source_context_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeChatTurn(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    text: row.text,
    meta: parseJson(row.meta_json, {}),
    createdAt: row.created_at
  };
}

function serializeChatEvent(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    channel: row.channel,
    externalChatId: row.external_chat_id,
    externalMessageId: row.external_message_id,
    sessionId: row.session_id || "",
    taskId: row.task_id || "",
    status: row.status,
    userText: row.user_text || "",
    action: row.action || "",
    errorText: row.error_text || "",
    meta: parseJson(row.meta_json, {}),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null
  };
}

function makeTaskId(sequence) {
  return `T-${String(sequence).padStart(5, "0")}`;
}

function normalizeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

export class TaskHubStore {
  constructor(options) {
    this.dbPath = options.dbPath;
    this.launcherProfilesPath = options.launcherProfilesPath;
    this.db = null;
  }

  async bootstrap() {
    this.db = await bootstrapAutomationDatabase(this.dbPath);
    await this.syncLauncherProfiles();
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  ensureDb() {
    if (!this.db) {
      throw new Error("TaskHubStore is not bootstrapped.");
    }
    return this.db;
  }

  async syncLauncherProfiles() {
    const db = this.ensureDb();
    let profiles = [];
    try {
      const raw = await readFile(this.launcherProfilesPath, "utf8");
      const parsed = JSON.parse(raw);
      profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
    } catch {
      profiles = [];
    }
    const statement = db.prepare(`
      INSERT INTO project_profiles (
        id, name, workspace_path, port, expected_place_id, wsl_workspace_path, favorite, last_seen_at, source_json
      ) VALUES (
        $id, $name, $workspacePath, $port, $expectedPlaceId, $wslWorkspacePath, $favorite, $lastSeenAt, $sourceJson
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        workspace_path = excluded.workspace_path,
        port = excluded.port,
        expected_place_id = excluded.expected_place_id,
        favorite = excluded.favorite,
        last_seen_at = excluded.last_seen_at,
        source_json = excluded.source_json
    `);
    const seen = nowIso();
    for (const profile of profiles) {
      statement.run({
        $id: normalizeText(profile.id),
        $name: normalizeText(profile.name, "Project"),
        $workspacePath: normalizeText(profile.workspacePath),
        $port: normalizeText(profile.port),
        $expectedPlaceId: normalizeText(profile.expectedPlaceId),
        $wslWorkspacePath: "",
        $favorite: profile.favorite === true ? 1 : 0,
        $lastSeenAt: seen,
        $sourceJson: JSON.stringify(profile)
      });
    }
  }

  listProjectProfiles() {
    const db = this.ensureDb();
    return db.prepare(`SELECT * FROM project_profiles ORDER BY favorite DESC, name ASC`).all().map(serializeProjectProfile);
  }

  getProjectProfile(id) {
    const db = this.ensureDb();
    return serializeProjectProfile(db.prepare(`SELECT * FROM project_profiles WHERE id = ?`).get(id));
  }

  findProjectProfileByPort(port) {
    const db = this.ensureDb();
    return serializeProjectProfile(db.prepare(`SELECT * FROM project_profiles WHERE port = ?`).get(String(port)));
  }

  setRuntimeMeta(key, value) {
    const db = this.ensureDb();
    db.prepare(`
      INSERT INTO runtime_meta (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value ?? {}), nowIso());
  }

  getRuntimeMeta(key, fallback = null) {
    const db = this.ensureDb();
    const row = db.prepare(`SELECT value_json FROM runtime_meta WHERE key = ?`).get(key);
    return row ? parseJson(row.value_json, fallback) : fallback;
  }

  getChatSession(channel, externalId) {
    const db = this.ensureDb();
    return serializeChatSession(db.prepare(`
      SELECT * FROM chat_sessions
      WHERE channel = ? AND external_id = ?
    `).get(normalizeText(channel), normalizeText(externalId)));
  }

  ensureChatSession(channel, externalId, patch = {}) {
    const db = this.ensureDb();
    const existing = this.getChatSession(channel, externalId);
    if (existing) {
      return this.updateChatSession(existing.id, patch);
    }
    const timestamp = nowIso();
    const record = {
      id: randomUUID(),
      channel: normalizeText(channel, "telegram"),
      externalId: normalizeText(externalId),
      conversationKey: normalizeText(patch.conversationKey, `${normalizeText(channel, "telegram")}:${normalizeText(externalId)}`),
      lastTaskId: normalizeText(patch.lastTaskId),
      lastUserGoal: normalizeText(patch.lastUserGoal),
      lastAgentAction: normalizeText(patch.lastAgentAction),
      pendingExecution: patch.pendingExecution || {},
      lastSuggestions: Array.isArray(patch.lastSuggestions) ? patch.lastSuggestions : [],
      sourceContext: patch.sourceContext || {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
    db.prepare(`
      INSERT INTO chat_sessions (
        id, channel, external_id, conversation_key, last_task_id, last_user_goal, last_agent_action,
        pending_execution_json, last_suggestions_json, source_context_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.channel,
      record.externalId,
      record.conversationKey,
      record.lastTaskId,
      record.lastUserGoal,
      record.lastAgentAction,
      JSON.stringify(record.pendingExecution),
      JSON.stringify(record.lastSuggestions),
      JSON.stringify(record.sourceContext),
      record.createdAt,
      record.updatedAt
    );
    return this.getChatSession(channel, externalId);
  }

  updateChatSession(id, patch = {}) {
    const db = this.ensureDb();
    const current = serializeChatSession(db.prepare(`SELECT * FROM chat_sessions WHERE id = ?`).get(id));
    if (!current) {
      throw new Error(`Chat session ${id} not found.`);
    }
    const next = {
      ...current,
      conversationKey: patch.conversationKey !== undefined ? normalizeText(patch.conversationKey, current.conversationKey) : current.conversationKey,
      lastTaskId: patch.lastTaskId !== undefined ? normalizeText(patch.lastTaskId) : current.lastTaskId,
      lastUserGoal: patch.lastUserGoal !== undefined ? normalizeText(patch.lastUserGoal) : current.lastUserGoal,
      lastAgentAction: patch.lastAgentAction !== undefined ? normalizeText(patch.lastAgentAction) : current.lastAgentAction,
      pendingExecution: patch.pendingExecution !== undefined ? (patch.pendingExecution || {}) : current.pendingExecution,
      lastSuggestions: patch.lastSuggestions !== undefined ? (Array.isArray(patch.lastSuggestions) ? patch.lastSuggestions : []) : current.lastSuggestions,
      sourceContext: patch.sourceContext !== undefined ? (patch.sourceContext || {}) : current.sourceContext,
      updatedAt: nowIso()
    };
    db.prepare(`
      UPDATE chat_sessions SET
        conversation_key = ?,
        last_task_id = ?,
        last_user_goal = ?,
        last_agent_action = ?,
        pending_execution_json = ?,
        last_suggestions_json = ?,
        source_context_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      next.conversationKey,
      next.lastTaskId,
      next.lastUserGoal,
      next.lastAgentAction,
      JSON.stringify(next.pendingExecution || {}),
      JSON.stringify(next.lastSuggestions || []),
      JSON.stringify(next.sourceContext || {}),
      next.updatedAt,
      id
    );
    return serializeChatSession(db.prepare(`SELECT * FROM chat_sessions WHERE id = ?`).get(id));
  }

  appendChatTurn(sessionId, role, text, meta = {}) {
    const db = this.ensureDb();
    const record = {
      id: randomUUID(),
      sessionId,
      role: normalizeText(role, "user"),
      text: normalizeText(text),
      meta,
      createdAt: nowIso()
    };
    db.prepare(`
      INSERT INTO chat_turns (id, session_id, role, text, meta_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.id, record.sessionId, record.role, record.text, JSON.stringify(record.meta || {}), record.createdAt);
    return record;
  }

  listChatTurns(sessionId, limit = 12) {
    const db = this.ensureDb();
    return db.prepare(`
      SELECT * FROM chat_turns
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, Number(limit)).map(serializeChatTurn).reverse();
  }

  createChatEvent(input) {
    const db = this.ensureDb();
    const timestamp = nowIso();
    const record = {
      id: randomUUID(),
      channel: normalizeText(input.channel, "telegram"),
      externalChatId: normalizeText(input.externalChatId),
      externalMessageId: normalizeText(input.externalMessageId),
      sessionId: normalizeText(input.sessionId),
      taskId: normalizeText(input.taskId),
      status: normalizeText(input.status, "received"),
      userText: normalizeText(input.userText),
      action: normalizeText(input.action),
      errorText: normalizeText(input.errorText),
      meta: input.meta || {},
      startedAt: timestamp,
      updatedAt: timestamp,
      completedAt: input.completedAt || null
    };
    db.prepare(`
      INSERT INTO chat_events (
        id, channel, external_chat_id, external_message_id, session_id, task_id, status,
        user_text, action, error_text, meta_json, started_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.channel,
      record.externalChatId,
      record.externalMessageId,
      record.sessionId,
      record.taskId,
      record.status,
      record.userText,
      record.action,
      record.errorText,
      JSON.stringify(record.meta),
      record.startedAt,
      record.updatedAt,
      record.completedAt
    );
    return serializeChatEvent(db.prepare(`SELECT * FROM chat_events WHERE id = ?`).get(record.id));
  }

  updateChatEvent(id, patch = {}) {
    const db = this.ensureDb();
    const current = serializeChatEvent(db.prepare(`SELECT * FROM chat_events WHERE id = ?`).get(id));
    if (!current) {
      throw new Error(`Chat event ${id} not found.`);
    }
    const next = {
      ...current,
      sessionId: patch.sessionId !== undefined ? normalizeText(patch.sessionId) : current.sessionId,
      taskId: patch.taskId !== undefined ? normalizeText(patch.taskId) : current.taskId,
      status: patch.status !== undefined ? normalizeText(patch.status, current.status) : current.status,
      action: patch.action !== undefined ? normalizeText(patch.action) : current.action,
      errorText: patch.errorText !== undefined ? normalizeText(patch.errorText) : current.errorText,
      meta: patch.meta !== undefined ? (patch.meta || {}) : current.meta,
      updatedAt: nowIso(),
      completedAt: patch.completedAt !== undefined
        ? patch.completedAt
        : (["completed", "failed"].includes(patch.status) ? nowIso() : current.completedAt)
    };
    db.prepare(`
      UPDATE chat_events SET
        session_id = ?,
        task_id = ?,
        status = ?,
        action = ?,
        error_text = ?,
        meta_json = ?,
        updated_at = ?,
        completed_at = ?
      WHERE id = ?
    `).run(
      next.sessionId,
      next.taskId,
      next.status,
      next.action,
      next.errorText,
      JSON.stringify(next.meta || {}),
      next.updatedAt,
      next.completedAt,
      id
    );
    return serializeChatEvent(db.prepare(`SELECT * FROM chat_events WHERE id = ?`).get(id));
  }

  getLatestChatEvent(channel, externalChatId) {
    const db = this.ensureDb();
    return serializeChatEvent(db.prepare(`
      SELECT * FROM chat_events
      WHERE channel = ? AND external_chat_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(normalizeText(channel), normalizeText(externalChatId)));
  }

  listChatEvents(channel, externalChatId, limit = 20) {
    const db = this.ensureDb();
    return db.prepare(`
      SELECT * FROM chat_events
      WHERE channel = ? AND external_chat_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(normalizeText(channel), normalizeText(externalChatId), Number(limit)).map(serializeChatEvent);
  }

  nextTaskId() {
    const db = this.ensureDb();
    const row = db.prepare(`SELECT COUNT(*) AS count FROM tasks`).get();
    return makeTaskId((row?.count || 0) + 1);
  }

  createTask(input) {
    const db = this.ensureDb();
    const id = normalizeText(input.id, this.nextTaskId());
    const createdAt = nowIso();
    const task = {
      id,
      source: normalizeText(input.source, "manual"),
      sourceRef: normalizeText(input.sourceRef),
      title: normalizeText(input.title, "Untitled task"),
      description: normalizeText(input.description),
      projectProfileId: normalizeText(input.projectProfileId),
      placeId: normalizeText(input.placeId),
      conversationKey: normalizeText(input.conversationKey),
      intentType: normalizeText(input.intentType, "general"),
      visibility: normalizeText(input.visibility, "normal"),
      state: taskStates.includes(input.state) ? input.state : "needs_triage",
      taskType: normalizeText(input.taskType, "general"),
      requiresStudio: input.requiresStudio === true,
      requiresManualVerification: input.requiresManualVerification === true,
      requiresClarification: input.requiresClarification === true,
      acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : [],
      executorPrompt: normalizeText(input.executorPrompt),
      blockedReason: normalizeText(input.blockedReason),
      triageSummary: normalizeText(input.triageSummary),
      executionSummary: normalizeText(input.executionSummary),
      sourceContext: input.sourceContext || {},
      lastAgentAction: normalizeText(input.lastAgentAction),
      lastUserGoal: normalizeText(input.lastUserGoal),
      executionPendingConfirmation: input.executionPendingConfirmation === true,
      lastOperatorMessageAt: normalizeText(input.lastOperatorMessageAt) || createdAt,
      createdAt,
      updatedAt: createdAt
    };
    db.prepare(`
      INSERT INTO tasks (
        id, source, source_ref, title, description, project_profile_id, place_id, state, task_type,
        conversation_key, intent_type, visibility,
        requires_studio, requires_manual_verification, requires_clarification, acceptance_criteria_json,
        executor_prompt, blocked_reason, triage_summary, execution_summary, source_context_json, last_agent_action,
        last_user_goal, execution_pending_confirmation, last_operator_message_at, created_at, updated_at
      ) VALUES (
        $id, $source, $sourceRef, $title, $description, $projectProfileId, $placeId, $state, $taskType,
        $conversationKey, $intentType, $visibility,
        $requiresStudio, $requiresManualVerification, $requiresClarification, $acceptanceCriteriaJson,
        $executorPrompt, $blockedReason, $triageSummary, $executionSummary, $sourceContextJson, $lastAgentAction,
        $lastUserGoal, $executionPendingConfirmation, $lastOperatorMessageAt, $createdAt, $updatedAt
      )
    `).run({
      $id: task.id,
      $source: task.source,
      $sourceRef: task.sourceRef,
      $title: task.title,
      $description: task.description,
      $projectProfileId: task.projectProfileId,
      $placeId: task.placeId,
      $state: task.state,
      $taskType: task.taskType,
      $conversationKey: task.conversationKey,
      $intentType: task.intentType,
      $visibility: task.visibility,
      $requiresStudio: task.requiresStudio ? 1 : 0,
      $requiresManualVerification: task.requiresManualVerification ? 1 : 0,
      $requiresClarification: task.requiresClarification ? 1 : 0,
      $acceptanceCriteriaJson: JSON.stringify(task.acceptanceCriteria),
      $executorPrompt: task.executorPrompt,
      $blockedReason: task.blockedReason,
      $triageSummary: task.triageSummary,
      $executionSummary: task.executionSummary,
      $sourceContextJson: JSON.stringify(task.sourceContext),
      $lastAgentAction: task.lastAgentAction,
      $lastUserGoal: task.lastUserGoal,
      $executionPendingConfirmation: task.executionPendingConfirmation ? 1 : 0,
      $lastOperatorMessageAt: task.lastOperatorMessageAt,
      $createdAt: task.createdAt,
      $updatedAt: task.updatedAt
    });
    return task;
  }

  updateTask(id, patch) {
    const db = this.ensureDb();
    const current = this.getTask(id);
    if (!current) {
      throw new Error(`Task ${id} not found.`);
    }
    const next = {
      ...current,
      title: patch.title !== undefined ? normalizeText(patch.title, current.title) : current.title,
      description: patch.description !== undefined ? normalizeText(patch.description) : current.description,
      projectProfileId: patch.projectProfileId !== undefined ? normalizeText(patch.projectProfileId) : current.projectProfileId,
      placeId: patch.placeId !== undefined ? normalizeText(patch.placeId) : current.placeId,
      conversationKey: patch.conversationKey !== undefined ? normalizeText(patch.conversationKey) : current.conversationKey,
      intentType: patch.intentType !== undefined ? normalizeText(patch.intentType, current.intentType) : current.intentType,
      visibility: patch.visibility !== undefined ? normalizeText(patch.visibility, current.visibility) : current.visibility,
      state: patch.state !== undefined ? patch.state : current.state,
      taskType: patch.taskType !== undefined ? normalizeText(patch.taskType, current.taskType) : current.taskType,
      requiresStudio: patch.requiresStudio !== undefined ? patch.requiresStudio === true : current.requiresStudio,
      requiresManualVerification: patch.requiresManualVerification !== undefined
        ? patch.requiresManualVerification === true
        : current.requiresManualVerification,
      requiresClarification: patch.requiresClarification !== undefined ? patch.requiresClarification === true : current.requiresClarification,
      acceptanceCriteria: patch.acceptanceCriteria !== undefined ? patch.acceptanceCriteria : current.acceptanceCriteria,
      executorPrompt: patch.executorPrompt !== undefined ? normalizeText(patch.executorPrompt) : current.executorPrompt,
      blockedReason: patch.blockedReason !== undefined ? normalizeText(patch.blockedReason) : current.blockedReason,
      triageSummary: patch.triageSummary !== undefined ? normalizeText(patch.triageSummary) : current.triageSummary,
      executionSummary: patch.executionSummary !== undefined ? normalizeText(patch.executionSummary) : current.executionSummary,
      sourceContext: patch.sourceContext !== undefined ? (patch.sourceContext || {}) : current.sourceContext,
      lastAgentAction: patch.lastAgentAction !== undefined ? normalizeText(patch.lastAgentAction) : current.lastAgentAction,
      lastUserGoal: patch.lastUserGoal !== undefined ? normalizeText(patch.lastUserGoal) : current.lastUserGoal,
      executionPendingConfirmation: patch.executionPendingConfirmation !== undefined
        ? patch.executionPendingConfirmation === true
        : current.executionPendingConfirmation,
      lastOperatorMessageAt: patch.lastOperatorMessageAt !== undefined
        ? normalizeText(patch.lastOperatorMessageAt) || null
        : current.lastOperatorMessageAt,
      updatedAt: nowIso()
    };
    if (!taskStates.includes(next.state)) {
      throw new Error(`Invalid task state ${next.state}.`);
    }
    db.prepare(`
      UPDATE tasks SET
        title = $title,
        description = $description,
        project_profile_id = $projectProfileId,
        place_id = $placeId,
        conversation_key = $conversationKey,
        intent_type = $intentType,
        visibility = $visibility,
        state = $state,
        task_type = $taskType,
        requires_studio = $requiresStudio,
        requires_manual_verification = $requiresManualVerification,
        requires_clarification = $requiresClarification,
        acceptance_criteria_json = $acceptanceCriteriaJson,
        executor_prompt = $executorPrompt,
        blocked_reason = $blockedReason,
        triage_summary = $triageSummary,
        execution_summary = $executionSummary,
        source_context_json = $sourceContextJson,
        last_agent_action = $lastAgentAction,
        last_user_goal = $lastUserGoal,
        execution_pending_confirmation = $executionPendingConfirmation,
        last_operator_message_at = $lastOperatorMessageAt,
        updated_at = $updatedAt
      WHERE id = $id
    `).run({
      $id: id,
      $title: next.title,
      $description: next.description,
      $projectProfileId: next.projectProfileId,
      $placeId: next.placeId,
      $conversationKey: next.conversationKey,
      $intentType: next.intentType,
      $visibility: next.visibility,
      $state: next.state,
      $taskType: next.taskType,
      $requiresStudio: next.requiresStudio ? 1 : 0,
      $requiresManualVerification: next.requiresManualVerification ? 1 : 0,
      $requiresClarification: next.requiresClarification ? 1 : 0,
      $acceptanceCriteriaJson: JSON.stringify(next.acceptanceCriteria || []),
      $executorPrompt: next.executorPrompt,
      $blockedReason: next.blockedReason,
      $triageSummary: next.triageSummary,
      $executionSummary: next.executionSummary,
      $sourceContextJson: JSON.stringify(next.sourceContext || {}),
      $lastAgentAction: next.lastAgentAction,
      $lastUserGoal: next.lastUserGoal,
      $executionPendingConfirmation: next.executionPendingConfirmation ? 1 : 0,
      $lastOperatorMessageAt: next.lastOperatorMessageAt,
      $updatedAt: next.updatedAt
    });
    return this.getTask(id);
  }

  getTask(id) {
    const db = this.ensureDb();
    return serializeTask(db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id));
  }

  listTasks(options = {}) {
    const db = this.ensureDb();
    const filters = [];
    const values = [];
    if (options.state) {
      filters.push(`state = ?`);
      values.push(options.state);
    }
    if (options.source) {
      filters.push(`source = ?`);
      values.push(options.source);
    }
    if (options.projectProfileId) {
      filters.push(`project_profile_id = ?`);
      values.push(options.projectProfileId);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    return db.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC`).all(...values).map(serializeTask);
  }

  searchTasks(query, options = {}) {
    const needle = normalizeText(query).toLowerCase();
    const tasks = this.listTasks(options);
    if (!needle) {
      return tasks;
    }
    return tasks.filter((task) => {
      const links = this.listLinks(task.id, "linear_issue");
      return task.id.toLowerCase().includes(needle)
        || task.title.toLowerCase().includes(needle)
        || task.description.toLowerCase().includes(needle)
        || task.lastUserGoal.toLowerCase().includes(needle)
        || links.some((link) => {
          const identifier = String(link.meta?.identifier || link.externalId || "").toLowerCase();
          return identifier.includes(needle);
        });
    });
  }

  listBlockedTasks(options = {}) {
    return this.listTasks({
      ...options,
      state: "blocked_manual"
    });
  }

  listActiveTasksForChat(chatId) {
    const db = this.ensureDb();
    return db.prepare(`
      SELECT DISTINCT tasks.* FROM tasks
      INNER JOIN task_links ON task_links.task_id = tasks.id
      WHERE task_links.link_type = 'telegram_chat'
        AND task_links.external_id = ?
        AND tasks.state IN ('needs_clarification', 'ready_for_execution', 'blocked_manual', 'executing', 'review')
      ORDER BY tasks.updated_at DESC
    `).all(String(chatId)).map(serializeTask);
  }

  listTasksByConversationKey(conversationKey) {
    return this.listTasks().filter((task) => task.conversationKey === String(conversationKey || ""));
  }

  appendMessage(taskId, input) {
    const db = this.ensureDb();
    const id = randomUUID();
    const createdAt = nowIso();
    db.prepare(`
      INSERT INTO task_messages (id, task_id, source, direction, message_type, body, meta_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      taskId,
      normalizeText(input.source, "manual"),
      normalizeText(input.direction, "inbound"),
      normalizeText(input.messageType, "note"),
      normalizeText(input.body),
      JSON.stringify(input.meta || {}),
      createdAt
    );
    return serializeMessage(db.prepare(`SELECT * FROM task_messages WHERE id = ?`).get(id));
  }

  listMessages(taskId) {
    const db = this.ensureDb();
    return db.prepare(`SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at ASC`).all(taskId).map(serializeMessage);
  }

  replaceOpenQuestions(taskId, questions) {
    const db = this.ensureDb();
    const now = nowIso();
    db.prepare(`UPDATE task_questions SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status = 'open'`).run(now, taskId);
    const insert = db.prepare(`
      INSERT INTO task_questions (id, task_id, question, status, answer, created_at, updated_at)
      VALUES (?, ?, ?, 'open', '', ?, ?)
    `);
    for (const question of questions) {
      insert.run(randomUUID(), taskId, normalizeText(question), now, now);
    }
    return this.listQuestions(taskId);
  }

  answerNextOpenQuestion(taskId, answer) {
    const db = this.ensureDb();
    const row = db.prepare(`
      SELECT * FROM task_questions
      WHERE task_id = ? AND status = 'open'
      ORDER BY created_at ASC
      LIMIT 1
    `).get(taskId);
    if (!row) {
      return null;
    }
    const updatedAt = nowIso();
    db.prepare(`
      UPDATE task_questions
      SET status = 'answered', answer = ?, updated_at = ?
      WHERE id = ?
    `).run(normalizeText(answer), updatedAt, row.id);
    return serializeQuestion(db.prepare(`SELECT * FROM task_questions WHERE id = ?`).get(row.id));
  }

  listQuestions(taskId) {
    const db = this.ensureDb();
    return db.prepare(`SELECT * FROM task_questions WHERE task_id = ? ORDER BY created_at ASC`).all(taskId).map(serializeQuestion);
  }

  listOpenQuestions(taskId) {
    return this.listQuestions(taskId).filter((question) => question.status === "open");
  }

  createRun(taskId, input) {
    const db = this.ensureDb();
    const run = {
      id: randomUUID(),
      taskId,
      mode: normalizeText(input.mode),
      status: normalizeText(input.status, "running"),
      runtime: normalizeText(input.runtime, "unknown"),
      startedAt: nowIso(),
      endedAt: null,
      summary: normalizeText(input.summary),
      input: input.input || {},
      output: input.output || {},
      error: input.error || {}
    };
    db.prepare(`
      INSERT INTO task_runs (id, task_id, mode, status, runtime, started_at, ended_at, summary, input_json, output_json, error_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.taskId,
      run.mode,
      run.status,
      run.runtime,
      run.startedAt,
      run.endedAt,
      run.summary,
      JSON.stringify(run.input),
      JSON.stringify(run.output),
      JSON.stringify(run.error)
    );
    return run;
  }

  finishRun(id, patch) {
    const db = this.ensureDb();
    db.prepare(`
      UPDATE task_runs SET
        status = ?,
        ended_at = ?,
        summary = ?,
        output_json = ?,
        error_json = ?
      WHERE id = ?
    `).run(
      normalizeText(patch.status, "completed"),
      nowIso(),
      normalizeText(patch.summary),
      JSON.stringify(patch.output || {}),
      JSON.stringify(patch.error || {}),
      id
    );
    return serializeRun(db.prepare(`SELECT * FROM task_runs WHERE id = ?`).get(id));
  }

  listRuns(taskId) {
    const db = this.ensureDb();
    return db.prepare(`SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC`).all(taskId).map(serializeRun);
  }

  addArtifact(taskId, input) {
    const db = this.ensureDb();
    const record = {
      id: randomUUID(),
      taskId,
      runId: normalizeText(input.runId) || null,
      kind: normalizeText(input.kind, "file"),
      label: normalizeText(input.label, "artifact"),
      path: normalizeText(input.path),
      meta: input.meta || {},
      createdAt: nowIso()
    };
    db.prepare(`
      INSERT INTO task_artifacts (id, task_id, run_id, kind, label, path, meta_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.taskId, record.runId, record.kind, record.label, record.path, JSON.stringify(record.meta), record.createdAt);
    return record;
  }

  listArtifacts(taskId) {
    const db = this.ensureDb();
    return db.prepare(`SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at ASC`).all(taskId).map(serializeArtifact);
  }

  upsertLink(taskId, input) {
    const db = this.ensureDb();
    const id = randomUUID();
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO task_links (id, task_id, link_type, external_id, external_url, meta_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, link_type, external_id) DO UPDATE SET
        external_url = excluded.external_url,
        meta_json = excluded.meta_json,
        updated_at = excluded.updated_at
    `).run(
      id,
      taskId,
      normalizeText(input.linkType),
      normalizeText(input.externalId),
      normalizeText(input.externalUrl),
      JSON.stringify(input.meta || {}),
      timestamp,
      timestamp
    );
    return this.listLinks(taskId, input.linkType).find((entry) => entry.externalId === normalizeText(input.externalId)) || null;
  }

  listLinks(taskId, linkType = null) {
    const db = this.ensureDb();
    const rows = linkType
      ? db.prepare(`SELECT * FROM task_links WHERE task_id = ? AND link_type = ? ORDER BY created_at ASC`).all(taskId, linkType)
      : db.prepare(`SELECT * FROM task_links WHERE task_id = ? ORDER BY created_at ASC`).all(taskId);
    return rows.map(serializeLink);
  }

  findTaskByLink(linkType, externalId) {
    const db = this.ensureDb();
    const row = db.prepare(`
      SELECT tasks.* FROM tasks
      INNER JOIN task_links ON task_links.task_id = tasks.id
      WHERE task_links.link_type = ? AND task_links.external_id = ?
      ORDER BY tasks.updated_at DESC
      LIMIT 1
    `).get(linkType, String(externalId));
    return serializeTask(row);
  }

  findTaskByLinearIdentifier(identifier) {
    const needle = normalizeText(identifier).toLowerCase();
    if (!needle) {
      return null;
    }
    const tasks = this.listTasks({ source: "linear" });
    for (const task of tasks) {
      const link = this.listLinks(task.id, "linear_issue")[0] || null;
      const value = String(link?.meta?.identifier || task.sourceRef || "").toLowerCase();
      if (value === needle) {
        return task;
      }
    }
    return null;
  }

  getTaskSnapshot(taskId) {
    const task = this.getTask(taskId);
    if (!task) {
      return null;
    }
    return {
      task,
      messages: this.listMessages(taskId),
      questions: this.listQuestions(taskId),
      runs: this.listRuns(taskId),
      artifacts: this.listArtifacts(taskId),
      links: this.listLinks(taskId)
    };
  }
}
