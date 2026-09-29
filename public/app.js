const form = document.getElementById("search-form");
const input = document.getElementById("search-input");
const button = document.getElementById("search-button");
const message = document.getElementById("search-message");
const results = document.getElementById("search-results");
let controller;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function image(url) {
  const fallback = node("span", "No image", "image-placeholder");
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      ![
        "emoji.slack-edge.com",
        "a.slack-edge.com",
        "b.slack-edge.com",
      ].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      (parsed.port && parsed.port !== "443")
    )
      return fallback;
    const img = document.createElement("img");
    img.alt = "";
    img.width = 48;
    img.height = 48;
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

async function search() {
  const q = input.value.trim();
  if (!q) return;
  controller?.abort();
  const current = new AbortController();
  controller = current;
  const mode = new FormData(form).get("mode");
  button.disabled = true;
  results.replaceChildren();
  results.setAttribute("aria-busy", "true");
  message.className = "";
  message.textContent = "Searching…";
  try {
    const response = await fetch(
      `/api/search?${new URLSearchParams({ q, mode, limit: "10" })}`,
      {
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(10000)]),
        redirect: "error",
      },
    );
    if (!response.ok) {
      if (response.status === 429)
        throw new Error("Too many searches. Wait a minute and try again.");
      if (response.status === 503 && mode === "semantic")
        throw new Error(
          "Semantic search is unavailable. Try again or switch to Keyword.",
        );
      throw new Error("Search is unavailable. Please try again.");
    }
    const data = await response.json();
    if (current.signal.aborted) return;
    const hits = data.results.slice(0, 10);
    results.replaceChildren(
      ...hits.map((hit) => {
        const row = node("li", undefined, "search-hit");
        const body = node("div", undefined, "hit-body");
        body.append(node("h2", hit.shortcode), node("p", hit.summary));
        row.append(image(hit.imageUrl), body);
        return row;
      }),
    );
    message.textContent = hits.length
      ? `${hits.length} results · ${mode === "semantic" ? "Semantic" : "Keyword"}${mode === "semantic" ? " · Index coverage is still growing." : ""}`
      : "No matches. Try a different name or description.";
  } catch (error) {
    if (current.signal.aborted) return;
    message.className = "error";
    message.textContent =
      error.name === "TimeoutError"
        ? "Search took too long. Please try again."
        : error instanceof TypeError
          ? "Could not connect. Check your connection and try again."
          : error.message;
  } finally {
    if (controller === current) {
      results.removeAttribute("aria-busy");
      button.disabled = false;
    }
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void search();
});
form.addEventListener("change", (event) => {
  if (event.target.name !== "mode") return;
  if (input.value.trim()) void search();
  else
    message.textContent =
      new FormData(form).get("mode") === "semantic"
        ? "Search by meaning. Some emoji may not be indexed yet."
        : "Search names and descriptions. Up to 10 results.";
});
