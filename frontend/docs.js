import "@fontsource-variable/inter";
import "./styles.css";
const host = document.querySelector("#api-reference");
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
async function load() {
  const token = sessionStorage.getItem("6b-token");
  const response = await fetch("/openapi.json", {
    headers: token ? { Authorization: "Bearer " + token } : {},
  });
  if (!response.ok) {
    host.textContent =
      "Unlock the workspace in the main application, then reload this page.";
    return;
  }
  const schema = await response.json();
  host.innerHTML =
    Object.entries(schema.paths)
      .map(([path, methods]) =>
        Object.entries(methods)
          .map(
            ([method, operation]) =>
              `<details class="activity"><summary><span class="badge">${esc(method.toUpperCase())}</span> <code>${esc(path)}</code> <span class="muted">${esc(operation.summary || "")}</span></summary><div style="padding:16px"><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.7">${esc(JSON.stringify(operation, null, 2))}</pre></div></details>`,
          )
          .join(""),
      )
      .join("") +
    `<details class="activity"><summary>Request and response schemas</summary><pre style="padding:20px;white-space:pre-wrap;font-size:11px;overflow-wrap:anywhere">${esc(JSON.stringify(schema.components?.schemas, null, 2))}</pre></details>`;
}
load().catch((e) => {
  host.textContent = "Unable to load API schema: " + e.message;
});
