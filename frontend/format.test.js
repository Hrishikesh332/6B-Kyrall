import { test } from "node:test";
import assert from "node:assert/strict";
import { renderText } from "./format.js";
test("model HTML and script URLs remain inert text", () => {
  const value = renderText(
    '<img src=x onerror="alert(1)">\n[jump](javascript:alert(1))',
  );
  assert.ok(!value.includes("<img"));
  assert.ok(!value.includes("<a "));
  assert.ok(value.includes("&lt;img"));
});
test("lists and emphasis render without interpreting raw code", () => {
  const value = renderText(
    "**Delivered**\n\n- STEP\n- STL\n\n```html\n<script>test</script>\n```",
  );
  assert.ok(value.includes("<strong>Delivered</strong>"));
  assert.ok(value.includes("<ul><li>STEP</li><li>STL</li></ul>"));
  assert.ok(value.includes("&lt;script&gt;test&lt;/script&gt;"));
});
