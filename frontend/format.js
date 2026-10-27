// Small, deliberately non-HTML subset for model-authored messages.
export function renderText(value) {
  const escape = (s) =>
    s.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const inline = (s) =>
    escape(s)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  let output = [],
    paragraph = [],
    list = [],
    code = null;
  const flush = () => {
    if (paragraph.length) {
      output.push("<p>" + paragraph.join("<br>") + "</p>");
      paragraph = [];
    }
    if (list.length) {
      output.push(
        "<ul>" + list.map((s) => "<li>" + s + "</li>").join("") + "</ul>",
      );
      list = [];
    }
  };
  for (const line of String(value ?? "").split("\n")) {
    if (line.startsWith("```")) {
      flush();
      if (code !== null) {
        output.push("<pre><code>" + escape(code.join("\n")) + "</code></pre>");
        code = null;
      } else code = [];
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^[-*] /.test(line)) {
      if (paragraph.length) flush();
      list.push(inline(line.slice(2)));
      continue;
    }
    if (list.length) flush();
    if (/^#{1,4} /.test(line)) {
      flush();
      output.push("<h4>" + inline(line.replace(/^#{1,4} /, "")) + "</h4>");
      continue;
    }
    paragraph.push(inline(line));
  }
  flush();
  if (code !== null)
    output.push("<pre><code>" + escape(code.join("\n")) + "</code></pre>");
  return output.join("");
}
