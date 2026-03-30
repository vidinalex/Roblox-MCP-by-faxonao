const launcher = window.rbxmcpLauncher;

const activityBar = document.getElementById("activityBar");
const profileGrid = document.getElementById("profileGrid");
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
  const label = String(status || "stopped").replaceAll("_", " ");
  return `<span class="badge ${escapeHtml(status || "stopped")}">${escapeHtml(label)}</span>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function healthSnapshot(profile) {
  const runtime = profile.runtime || {};
  const health = runtime.lastHealth?.body || {};
  const activePlace = health.placeId || health.expectedPlaceId || "-";
  const studio = health.studioOnline === true ? "Studio attached" : "Studio waiting";
  const writes = health.scriptWriteOk === true ? "Writes ready" : "Writes not ready";
  const session = health.sessionId || "-";
  return {
    activePlace,
    session,
    studio,
    writes,
    note: runtime.lastError || "No active launcher errors."
  };
}

function isRuntimeActive(profile) {
  return !["stopped", "port_conflict"].includes(String(profile.status || "stopped"));
}

function runtimeCopy(profile) {
  if (isRuntimeActive(profile)) {
    return {
      title: profile.status === "starting" ? "Starting" : "Running",
      hint: "Stop this profile"
    };
  }
  return {
    title: "Stopped",
    hint: "Start this profile"
  };
}

function profileMeta(profile) {
  const snapshot = healthSnapshot(profile);
  return `
    <div class="profile-meta-grid">
      <div class="meta-card">
        <div class="meta-label">Port</div>
        <div class="meta-value">${escapeHtml(profile.port)}</div>
      </div>
      <div class="meta-card">
        <div class="meta-label">Place</div>
        <div class="meta-value">${escapeHtml(profile.expectedPlaceId || "-")}</div>
      </div>
      <div class="meta-card wide">
        <div class="meta-label">Workspace</div>
        <div class="meta-value compact clamp-2" title="${escapeHtml(profile.workspacePath)}">${escapeHtml(profile.workspacePath)}</div>
      </div>
      <div class="meta-card">
        <div class="meta-label">Session</div>
        <div class="meta-value compact">${escapeHtml(snapshot.session)}</div>
      </div>
      <div class="meta-card">
        <div class="meta-label">Active Place</div>
        <div class="meta-value compact">${escapeHtml(snapshot.activePlace)}</div>
      </div>
    </div>
  `;
}

function renderProfileCard(profile) {
  const runtime = runtimeCopy(profile);
  const snapshot = healthSnapshot(profile);
  const active = isRuntimeActive(profile);
  const card = document.createElement("article");
  card.className = "profile-card";
  card.innerHTML = `
    <div class="profile-header">
      <div class="profile-title-stack">
        <div class="profile-title">${escapeHtml(profile.name)}</div>
        <div class="profile-badges">
          ${badge(profile.status)}
          ${profile.favorite ? '<span class="badge">Pinned</span>' : ""}
        </div>
      </div>
    </div>
    ${profileMeta(profile)}
    <div class="status-strip">
      <div class="status-head">
        <span class="status-kicker">Health</span>
      </div>
      <div class="status-copy">${escapeHtml(snapshot.studio)} | ${escapeHtml(snapshot.writes)} | Active place ${escapeHtml(snapshot.activePlace)}</div>
      <div class="status-copy clamp-2" title="${escapeHtml(snapshot.note)}">${escapeHtml(snapshot.note)}</div>
    </div>
    <div></div>
    <div class="card-footer">
      <div class="card-footer-top">
        <button class="runtime-toggle ${active ? "is-on" : ""}" data-action="toggle-runtime" role="switch" aria-checked="${active ? "true" : "false"}">
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
          <span class="toggle-copy">
            <strong>${escapeHtml(runtime.title)}</strong>
            <span>${escapeHtml(runtime.hint)}</span>
          </span>
        </button>
      </div>
      <div class="card-action-group">
        <button class="ghost" data-action="copy-prompt">AI Prompt</button>
        <button class="ghost" data-action="copy-diag">Diagnostics</button>
        <button class="ghost" data-action="edit">Edit</button>
        <button class="ghost danger" data-action="delete">Delete</button>
      </div>
    </div>
  `;
  attachActionHandlers(card, profile);
  return card;
}

function attachActionHandlers(container, profile) {
  for (const button of container.querySelectorAll("button[data-action]")) {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      try {
        await runAction(async () => {
          if (action === "toggle-runtime") {
            if (isRuntimeActive(profile)) {
              await launcher.stopProfile(profile.id);
            } else {
              await launcher.startProfile(profile.id);
            }
          } else if (action === "edit") {
            populateForm(profile);
            await loadLogs(profile.id);
            return;
          } else if (action === "delete") {
            await launcher.deleteProfile(profile.id);
            if (selectedProfileId === profile.id) {
              resetForm();
            }
          } else if (action === "copy-diag") {
            await launcher.copyDiagnostics(profile.id);
            showMessage(`Copied diagnostics for ${profile.name}.`);
            return;
          } else if (action === "copy-prompt") {
            await launcher.copyAiPrompt(profile.id);
            showMessage(`Copied AI prompt for ${profile.name}.`);
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
  profileGrid.innerHTML = "";
  if (sorted.length === 0) {
    profileGrid.innerHTML = `<div class="empty-state">Create your first profile and keep each Roblox place on its own port.</div>`;
    return;
  }
  for (const profile of sorted) {
    profileGrid.appendChild(renderProfileCard(profile));
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
  void loadLogs();
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
