const launcher = window.rbxmcpLauncher;

const activityBar = document.getElementById("activityBar");
const primaryCards = document.getElementById("primaryCards");
const profileList = document.getElementById("profileList");
const profileForm = document.getElementById("profileForm");
const formMessage = document.getElementById("formMessage");
const editorTitle = document.getElementById("editorTitle");
const refreshButton = document.getElementById("refreshButton");
const createButton = document.getElementById("createButton");
const resetFormButton = document.getElementById("resetFormButton");
const logsView = document.getElementById("logsView");
const logsTitle = document.getElementById("logsTitle");
const openLogButton = document.getElementById("openLogButton");

const fields = {
  id: document.getElementById("profileId"),
  name: document.getElementById("profileName"),
  workspacePath: document.getElementById("workspacePath"),
  port: document.getElementById("profilePort"),
  expectedPlaceId: document.getElementById("expectedPlaceId"),
  favorite: document.getElementById("favoriteToggle"),
  autoStart: document.getElementById("autoStartToggle")
};

let currentState = { profiles: [], defaultWorkspacePath: "" };
let selectedProfileId = null;
let pendingCount = 0;

function setBusy(isBusy) {
  pendingCount += isBusy ? 1 : -1;
  pendingCount = Math.max(0, pendingCount);
  const busy = pendingCount > 0;
  activityBar.hidden = !busy;
  document.body.classList.toggle("busy", busy);
}

async function runAction(action, button = null) {
  setBusy(true);
  if (button) {
    button.disabled = true;
    button.classList.add("is-busy");
  }
  try {
    return await action();
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove("is-busy");
    }
    setBusy(false);
  }
}

function badge(status) {
  const label = String(status || "stopped").replace(/_/g, " ");
  return `<span class="badge ${status}">${label}</span>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function healthMeta(profile) {
  const runtime = profile.runtime || {};
  const health = runtime.lastHealth?.body || {};
  const placeId = health.placeId || health.expectedPlaceId || "-";
  const studio = health.studioOnline === true ? "Studio attached" : "Studio waiting";
  const writes = health.scriptWriteOk === true ? "Writes ready" : "Writes not ready";
  const session = health.sessionId || "-";
  return `
    <div class="meta-block">
      <div class="meta-line"><strong>Port</strong> ${escapeHtml(profile.port)} | <strong>Place</strong> ${escapeHtml(profile.expectedPlaceId || "-")}</div>
      <div class="meta-line"><strong>Workspace</strong> ${escapeHtml(profile.workspacePath)}</div>
      <div class="meta-line"><strong>Session</strong> ${escapeHtml(session)}</div>
      <div class="meta-line">${escapeHtml(studio)} | ${escapeHtml(writes)} | Active place ${escapeHtml(placeId)}</div>
    </div>
  `;
}

function primaryActionLabel(profile) {
  return profile.status === "stopped" ? "Start" : "Restart";
}

function attachActionHandlers(container, profile) {
  for (const button of container.querySelectorAll("button[data-action]")) {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      try {
        await runAction(async () => {
          if (action === "primary") {
            if (profile.status === "stopped") {
              await launcher.startProfile(profile.id);
            } else {
              await launcher.restartProfile(profile.id);
            }
          } else if (action === "stop") {
            await launcher.stopProfile(profile.id);
          } else if (action === "edit") {
            populateForm(profile);
            return;
          } else if (action === "duplicate") {
            await launcher.duplicateProfile(profile.id);
          } else if (action === "delete") {
            await launcher.deleteProfile(profile.id);
            if (selectedProfileId === profile.id) {
              resetForm();
            }
          } else if (action === "copy-url") {
            await launcher.copyMcpUrl(profile.port);
            showMessage(`Copied MCP URL for ${profile.name}.`);
            return;
          } else if (action === "copy-diag") {
            await launcher.copyDiagnostics(profile.id);
            showMessage(`Copied diagnostics for ${profile.name}.`);
            return;
          } else if (action === "copy-prompt") {
            await launcher.copyAiPrompt(profile.id);
            showMessage(`Copied AI prompt for ${profile.name}.`);
            return;
          } else if (action === "logs") {
            selectedProfileId = profile.id;
            await loadLogs(profile.id);
            return;
          }
          await refresh();
        }, button);
      } catch (error) {
        showMessage(error.message || String(error), true);
      }
    });
  }
}

function renderCard(profile) {
  const card = document.createElement("article");
  card.className = "profile-card";
  card.innerHTML = `
    <div class="profile-title-row">
      <div class="profile-title">${escapeHtml(profile.name)}</div>
      ${badge(profile.status)}
      ${profile.favorite ? '<span class="badge">Pinned</span>' : ""}
    </div>
    ${healthMeta(profile)}
    <div class="status-note">${escapeHtml(profile.runtime?.lastError || "Ready for multi-project work.")}</div>
    <div class="card-actions">
      <button class="primary" data-action="primary">${primaryActionLabel(profile)}</button>
      <button class="secondary" data-action="stop">Stop</button>
      <button class="ghost" data-action="copy-prompt">Copy AI Prompt</button>
      <button class="ghost" data-action="copy-url">Copy MCP URL</button>
      <button class="ghost" data-action="copy-diag">Copy Diagnostics</button>
      <button class="ghost" data-action="logs">Focus Logs</button>
      <button class="ghost" data-action="edit">Edit</button>
    </div>
  `;
  attachActionHandlers(card, profile);
  return card;
}

function renderRow(profile) {
  const row = document.createElement("article");
  row.className = "profile-row";
  row.innerHTML = `
    <div>
      <div class="profile-title-row">
        <div class="profile-title">${escapeHtml(profile.name)}</div>
        ${badge(profile.status)}
        ${profile.favorite ? '<span class="badge">Pinned</span>' : ""}
      </div>
      ${healthMeta(profile)}
    </div>
    <div class="row-actions">
      <button class="primary" data-action="primary">${primaryActionLabel(profile)}</button>
      <button class="secondary" data-action="stop">Stop</button>
      <button class="ghost" data-action="copy-prompt">AI Prompt</button>
      <button class="ghost" data-action="copy-url">MCP URL</button>
      <button class="ghost" data-action="logs">Logs</button>
      <button class="ghost" data-action="duplicate">Duplicate</button>
      <button class="ghost" data-action="edit">Edit</button>
      <button class="ghost" data-action="delete">Delete</button>
    </div>
  `;
  attachActionHandlers(row, profile);
  return row;
}

function sortProfiles(profiles) {
  return [...profiles].sort((left, right) => {
    if (left.favorite !== right.favorite) {
      return left.favorite ? -1 : 1;
    }
    return String(right.lastUsedAt || "").localeCompare(String(left.lastUsedAt || ""));
  });
}

function renderProfiles() {
  const sorted = sortProfiles(currentState.profiles || []);
  const primary = sorted.slice(0, 2);
  const rest = sorted.slice(2);
  primaryCards.innerHTML = "";
  profileList.innerHTML = "";
  if (primary.length === 0) {
    primaryCards.innerHTML = `<div class="empty-state">Create your first profile and keep each Roblox place on its own port.</div>`;
  } else {
    for (const profile of primary) {
      primaryCards.appendChild(renderCard(profile));
    }
  }
  if (rest.length === 0) {
    profileList.innerHTML = `<div class="empty-state">No extra profiles yet.</div>`;
  } else {
    for (const profile of rest) {
      profileList.appendChild(renderRow(profile));
    }
  }
}

function populateForm(profile) {
  selectedProfileId = profile.id;
  editorTitle.textContent = `Edit ${profile.name}`;
  fields.id.value = profile.id;
  fields.name.value = profile.name;
  fields.workspacePath.value = profile.workspacePath;
  fields.port.value = profile.port;
  fields.expectedPlaceId.value = profile.expectedPlaceId || "";
  fields.favorite.checked = profile.favorite === true;
  fields.autoStart.checked = profile.autoStart === true;
  showMessage("");
}

function resetForm() {
  selectedProfileId = null;
  editorTitle.textContent = "Create Profile";
  fields.id.value = "";
  fields.name.value = "";
  fields.workspacePath.value = currentState.defaultWorkspacePath || "";
  fields.port.value = "";
  fields.expectedPlaceId.value = "";
  fields.favorite.checked = false;
  fields.autoStart.checked = false;
  showMessage("");
}

function showMessage(message, isError = false) {
  formMessage.textContent = message || "";
  formMessage.style.color = isError ? "#ff9a9a" : "";
}

async function loadLogs(profileId = null) {
  if (profileId) {
    const selected = currentState.profiles.find((profile) => profile.id === profileId);
    if (!selected) {
      return;
    }
    const logs = await launcher.getLogs(profileId);
    logsTitle.textContent = `${selected.name} Logs`;
    logsView.textContent = logs.lines.length > 0 ? logs.lines.join("\n") : `No logs captured yet for ${selected.name}.`;
    openLogButton.disabled = false;
    return;
  }
  const logs = await launcher.getAllLogs();
  logsTitle.textContent = `All Projects (${logs.profileCount})`;
  logsView.textContent = logs.lines.length > 0 ? logs.lines.join("\n") : "No logs captured yet.";
  openLogButton.disabled = true;
}

async function refresh() {
  currentState = await launcher.getState();
  renderProfiles();
  if (!fields.workspacePath.value) {
    fields.workspacePath.value = currentState.defaultWorkspacePath || "";
  }
  await loadLogs(selectedProfileId);
}

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    name: fields.name.value,
    workspacePath: fields.workspacePath.value,
    port: fields.port.value,
    expectedPlaceId: fields.expectedPlaceId.value,
    favorite: fields.favorite.checked,
    autoStart: fields.autoStart.checked
  };
  try {
    await runAction(async () => {
      if (fields.id.value) {
        await launcher.updateProfile(fields.id.value, payload);
        showMessage("Profile updated.");
      } else {
        await launcher.createProfile(payload);
        showMessage("Profile created.");
      }
      resetForm();
      await refresh();
    });
  } catch (error) {
    showMessage(error.message || String(error), true);
  }
});

refreshButton.addEventListener("click", async () => {
  try {
    await runAction(() => refresh(), refreshButton);
  } catch (error) {
    showMessage(error.message || String(error), true);
  }
});

createButton.addEventListener("click", () => resetForm());
resetFormButton.addEventListener("click", () => resetForm());
openLogButton.addEventListener("click", async () => {
  if (!selectedProfileId) {
    return;
  }
  await runAction(() => launcher.openLogFile(selectedProfileId), openLogButton);
});

resetForm();
await refresh();
setInterval(() => {
  if (pendingCount === 0) {
    void refresh();
  }
}, 3000);
