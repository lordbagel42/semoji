const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
let token = "";
let credentialVersion = 0;
let needsToken = false;
let statusBusy = false;
let pollTimer;
let recentSignature = "";
let searchController;

function text(id, value) {
  const element = $(id);
  if (element.textContent !== String(value)) element.textContent = value;
}

function node(tag, content, className) {
  const element = document.createElement(tag);
  if (content !== undefined) element.textContent = content;
  if (className) element.className = className;
  return element;
}

function message(id, content) {
  text(id, content);
  $(id).hidden = !content;
}

function requireToken() {
  token = "";
  credentialVersion += 1;
  needsToken = true;
  $("login").hidden = false;
  delete $("index-state").dataset.state;
  text("index-state", "Sign-in required");
  text("eta", "Unavailable");
  message(
    "connection-error",
    "A valid read token is required for indexing status. Search is available without signing in.",
  );
}

async function request(path, signal, authenticated = true) {
  const version = credentialVersion;
  const response = await fetch(path, {
    headers: authenticated && token ? { Authorization: `Bearer ${token}` } : {},
    cache: "no-store",
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (authenticated && version !== credentialVersion)
    throw new DOMException("Credentials changed", "AbortError");
  if (authenticated && response.status === 401) {
    requireToken();
    throw new Error("Sign-in required. Enter your read token above.");
  }
  if (!response.ok)
    throw new Error(`Request failed (HTTP ${response.status}).`);
  return response.json();
}

function image(url) {
  const fallback = node("span", "—", "image-placeholder");
  fallback.setAttribute("aria-label", "No preview");
  if (!url) return fallback;
  try {
    const parsed = new URL(url);
    const allowed = [
      "emoji.slack-edge.com",
      "a.slack-edge.com",
      "b.slack-edge.com",
    ];
    if (
      parsed.protocol !== "https:" ||
      !allowed.includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      (parsed.port && parsed.port !== "443")
    )
      return fallback;
    const img = document.createElement("img");
    img.alt = "";
    img.width = 40;
    img.height = 40;
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.src = parsed.href;
    img.addEventListener("error", () => img.replaceWith(fallback), {
      once: true,
    });
    return img;
  } catch {
    return fallback;
  }
}

function timestamp(id, value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    text(id, "unavailable");
    $(id).removeAttribute("datetime");
    return;
  }
  text(id, date.toLocaleString());
  $(id).dateTime = date.toISOString();
}

function estimatedTimeLeft(status) {
  const remaining = status.counts.pending + status.counts.running;
  if (!status.counts.total) return "No work";
  if (!remaining)
    return status.counts.failed || status.counts.unknown
      ? "Needs review"
      : "Complete";
  if (status.state !== "running")
    return status.state === "idle" ? "Not running" : "Paused";
  if (!(status.completedPerMinute > 0)) return "Calculating…";
  const minutes = Math.ceil(remaining / status.completedPerMinute);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `≈ ${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours) return `≈ ${hours}h ${minutes % 60}m`;
  return `≈ ${minutes} min`;
}

function renderStatus(status) {
  text("index-state", status.state);
  $("index-state").dataset.state = status.state;
  for (const key of [
    "total",
    "pending",
    "running",
    "completed",
    "failed",
    "unknown",
    "aliases",
  ]) {
    text(`count-${key}`, number.format(status.counts[key]));
  }
  text(
    "concurrency",
    `${number.format(status.concurrency)} / ${number.format(status.targetConcurrency)}`,
  );
  text("throughput", number.format(status.completedPerMinute));
  text("eta", estimatedTimeLeft(status));
  text(
    "memory",
    status.availableMemoryMb === null
      ? "Not reported"
      : `${number.format(status.availableMemoryMb)} MB`,
  );
  text("mode", status.mode === "cloud" ? "Cloud index" : "Local index");
  message("index-reason", status.reason || "");
  timestamp("index-updated", status.updatedAt);
  const signature = JSON.stringify(status.recent);
  if (signature === recentSignature) return;
  recentSignature = signature;
  const rows = status.recent.map((item) => {
    const row = node("tr");
    const identity = node("td");
    const label = node("div", undefined, "emoji-identity");
    label.append(image(item.imageUrl), node("span", `:${item.name}:`));
    identity.append(label);
    const state = node("td");
    state.append(node("span", item.state, "item-state"));
    const summary = node("td");
    if (item.summary) summary.append(node("p", item.summary));
    if (item.error) summary.append(node("p", item.error, "error-code"));
    if (!item.summary && !item.error)
      summary.textContent = "No description reported.";
    row.append(identity, state, summary);
    return row;
  });
  if (!rows.length) {
    const row = node("tr");
    const cell = node("td", "No recent activity reported.", "empty");
    cell.colSpan = 3;
    row.append(cell);
    rows.push(row);
  }
  $("recent-items").replaceChildren(...rows);
}

async function refreshStatus() {
  clearTimeout(pollTimer);
  if (statusBusy || needsToken) return;
  statusBusy = true;
  const version = credentialVersion;
  try {
    const status = await request("/api/status");
    // Another in-flight request may have rejected this credential.
    if (needsToken || version !== credentialVersion) return;
    renderStatus(status);
    timestamp("last-success", new Date());
    message("connection-error", "");
    if ($("login").contains(document.activeElement)) $("search-input").focus();
    $("login").hidden = true;
  } catch (error) {
    if (!needsToken && version === credentialVersion) {
      delete $("index-state").dataset.state;
      text("index-state", "Connection interrupted");
      text("eta", "Unavailable");
      message(
        "connection-error",
        `${error instanceof Error && error.message.startsWith("Request failed") ? error.message : "Could not refresh the index."} Showing the last received values; retrying in 3 seconds.`,
      );
    }
  } finally {
    statusBusy = false;
    if (!needsToken) pollTimer = setTimeout(refreshStatus, 3000);
  }
}

$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("token").value.trim();
  if (!value) return;
  credentialVersion += 1;
  token = value;
  $("token").value = "";
  needsToken = false;
  message("connection-error", "Connecting…");
  text("index-state", "Connecting");
  // If a status request is finishing, its finally block schedules the next poll.
  void refreshStatus();
});

$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $("search-input").value.trim();
  if (!query) return;
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  $("search-results").replaceChildren();
  $("search-results").setAttribute("aria-busy", "true");
  $("search-message").classList.remove("error");
  text("search-message", `Searching for “${query}”…`);
  try {
    const result = await request(
      `/api/search?${new URLSearchParams({ q: query, limit: "20" })}`,
      controller.signal,
      false,
    );
    if (controller.signal.aborted) return;
    const items = result.results.map((hit) => {
      const item = node("li", undefined, "search-hit");
      const body = node("div", undefined, "hit-body");
      const heading = node("div", undefined, "hit-heading");
      heading.append(
        node("h3", hit.shortcode),
        node("span", `${hit.match} match`, "match"),
      );
      body.append(heading);
      if (hit.canonicalName && hit.canonicalName !== hit.name)
        body.append(node("p", `Alias of :${hit.canonicalName}:`, "alias"));
      body.append(node("p", hit.summary));
      const detail = node("details");
      detail.append(
        node("summary", "Full description"),
        node("p", hit.description, "description"),
      );
      body.append(detail);
      item.append(image(hit.imageUrl), body);
      return item;
    });
    $("search-results").replaceChildren(...items);
    text(
      "search-message",
      `${items.length ? `${items.length} matches` : "No matches"} for “${query}” · ${result.mode === "hybrid" ? "Hybrid" : "Keyword"} search · ${number.format(result.durationMs)} ms${result.semanticAvailable ? "" : " · Semantic search unavailable"}.${items.length ? "" : " Try another name or a simpler description."}`,
    );
  } catch (error) {
    if (controller.signal.aborted) return;
    $("search-message").classList.add("error");
    text(
      "search-message",
      `${error instanceof Error && error.message.startsWith("Request failed") ? error.message : "Search could not connect."} Try searching again.`,
    );
  } finally {
    if (searchController === controller)
      $("search-results").removeAttribute("aria-busy");
  }
});

void refreshStatus();
