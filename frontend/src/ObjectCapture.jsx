import { useEffect, useRef, useState } from "react";
import { Camera, Plus, Trash2, Scan, ArrowRight } from "lucide-react";
import { api } from "./lib.js";
import { ErrorNotice } from "./ui.jsx";

const angles = [
  "front",
  "right",
  "top",
  "rear",
  "left",
  "bottom",
  "perspective",
];

function Photo({ taskId, artifact }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    let url;
    api(`/tasks/${taskId}/artifacts/${artifact.id}/content`, {
      raw: true,
      signal: controller.signal,
    })
      .then((r) => r.blob())
      .then((blob) => {
        if (!controller.signal.aborted) {
          url = URL.createObjectURL(blob);
          setSrc(url);
        }
      })
      .catch(() => {});
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [taskId, artifact.id]);
  return src ? (
    <img src={src} alt={artifact.metadata.original_name || artifact.name} />
  ) : (
    <Camera size={28} />
  );
}

export default function ObjectCapture({ task, cap, refresh, notify }) {
  const [views, setViews] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const [objective, setObjective] = useState("object_cad");
  const input = useRef(null),
    form = useRef(null),
    pending = useRef(null);
  const photos = task.artifacts.filter(
    (a) => a.metadata.kind === "reference_image",
  );
  const add = (artifact) =>
    setViews((current) =>
      current.length >= 12 || current.some((v) => v.artifact.id === artifact.id)
        ? current
        : [
            ...current,
            { artifact, angle: angles[current.length % angles.length] },
          ],
    );
  const upload = async (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    setBusy(true);
    setError(null);
    try {
      if (files.length + views.length > 12)
        throw new Error("Use up to 12 views per object.");
      for (const file of files) {
        if (file.size > 10 * 1024 * 1024)
          throw new Error(`${file.name} exceeds 10 MB.`);
        const body = new FormData();
        body.append("file", file);
        add(await api(`/tasks/${task.id}/uploads`, { method: "POST", body }));
      }
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const generate = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!views.length) throw new Error("Add at least one object photo.");
      const data = new FormData(form.current);
      const payload = {
        name: data.get("name"),
        objective,
        views: views.map((v) => ({
          artifact_id: v.artifact.id,
          angle: v.angle,
        })),
        dimension_notes: data.get("dimension_notes"),
        requirements: data.get("requirements"),
      };
      for (const key of ["width_mm", "depth_mm", "height_mm", "mass_kg"])
        payload[key] = data.get(key) ? Number(data.get(key)) : null;
      if (
        ![payload.width_mm, payload.depth_mm, payload.height_mm].some(Boolean)
      )
        throw new Error(
          "Enter at least one measured dimension to establish scale.",
        );
      const signature = JSON.stringify(payload);
      if (!pending.current || pending.current.signature !== signature) {
        const artifact = await api(`/tasks/${task.id}/image-sets`, {
          method: "POST",
          body: payload,
        });
        pending.current = { signature, artifact, key: crypto.randomUUID() };
      }
      const { artifact, key } = pending.current;
      await api(`/tasks/${task.id}/messages`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: {
          content: `Use image set ${artifact.id} (object_views.json) to ${objective === "gripper" ? "design a gripper with moving jaws that can close and release this object" : "reconstruct this object as parametric CAD"}. Inspect every photo and use the supplied measured dimensions. Deliver STEP, STL, construction source, reconstruction evidence and assembly notes. ${objective === "gripper" ? "Include an object reference part, motion studies and a requirement/bench-test review." : "Label all estimated and hidden features."} ${payload.requirements}`,
        },
      });
      pending.current = null;
      await refresh();
      notify("Photo design request queued. Follow progress in Conversation.");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="object-capture" ref={form} onSubmit={generate}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">FROM OBJECT TO DESIGN</span>
          <h2>Capture the whole picture</h2>
          <p className="muted">
            Use front, side and top photos of the same object, plus a measured
            dimension.
          </p>
        </div>
        <Scan size={30} />
      </div>
      <div className="capture-objective">
        {[
          [
            "object_cad",
            "Reconstruct object",
            "Create editable solids from the visible shape.",
          ],
          [
            "gripper",
            "Design a gripper",
            "Build around the object with moving jaws and clearance.",
          ],
        ].map(([value, title, detail]) => (
          <label key={value} className={objective === value ? "selected" : ""}>
            <input
              type="radio"
              name="objective"
              value={value}
              checked={objective === value}
              onChange={() => setObjective(value)}
            />
            <strong>{title}</strong>
            <small>{detail}</small>
          </label>
        ))}
      </div>
      <div className="capture-views">
        {views.map((view, index) => (
          <article className="capture-photo" key={view.artifact.id}>
            <Photo taskId={task.id} artifact={view.artifact} />
            <div>
              <select
                aria-label={`View angle ${index + 1}`}
                value={view.angle}
                onChange={(e) =>
                  setViews((current) =>
                    current.map((v, i) =>
                      i === index ? { ...v, angle: e.target.value } : v,
                    ),
                  )
                }
              >
                {angles.map((angle) => (
                  <option key={angle}>{angle}</option>
                ))}
              </select>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove photo ${index + 1}`}
                onClick={() =>
                  setViews((current) => current.filter((_, i) => i !== index))
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
            <small>
              {view.artifact.metadata.original_name || view.artifact.name}
            </small>
          </article>
        ))}
        <button
          type="button"
          className="capture-add"
          disabled={busy || views.length >= 12}
          onClick={() => input.current.click()}
        >
          <Plus size={22} />
          <strong>Add object photos</strong>
          <small>PNG, JPEG or WebP · up to 12 views</small>
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={upload}
      />
      {photos.some((p) => !views.some((v) => v.artifact.id === p.id)) && (
        <select
          aria-label="Use an attached photo"
          value=""
          onChange={(e) => add(photos.find((p) => p.id === e.target.value))}
        >
          <option value="" disabled>
            Use an attached photo…
          </option>
          {photos
            .filter((p) => !views.some((v) => v.artifact.id === p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · v{p.version}
              </option>
            ))}
        </select>
      )}
      <label>
        Object name
        <input
          name="name"
          required
          maxLength={100}
          placeholder="e.g. housing, bottle, tomato"
        />
      </label>
      <div className="capture-dimensions">
        {[
          ["width_mm", "Width X (mm)"],
          ["depth_mm", "Depth Y (mm)"],
          ["height_mm", "Height Z (mm)"],
          ["mass_kg", "Mass (kg), optional"],
        ].map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              name={key}
              type="number"
              step="any"
              min={key === "mass_kg" ? 0.001 : 0.2}
              max={key === "mass_kg" ? 100 : 1000}
              placeholder="Measured"
            />
          </label>
        ))}
      </div>
      <label>
        What was measured?
        <input
          name="dimension_notes"
          required
          minLength={3}
          maxLength={500}
          placeholder="e.g. width is the outside diameter; Z runs from base to lid"
        />
      </label>
      <label>
        {objective === "gripper"
          ? "Gripper requirements"
          : "Design requirements"}
        <textarea
          name="requirements"
          maxLength={4000}
          rows={3}
          placeholder={
            objective === "gripper"
              ? "Robot mount, jaw travel, material, delicate surfaces, allowed force, release behavior…"
              : "Features to preserve, manufacturing process and tolerances…"
          }
        />
      </label>
      <p className="capture-note">
        Photos guide a parametric reconstruction. Hidden surfaces and unmeasured
        dimensions remain estimates. For close fits, verify the dimensions
        before manufacturing.
      </p>
      {cap?.provider !== "claude" && (
        <p className="validation-panel warning">
          Photo interpretation requires Claude Code. Your photos can still be
          attached and saved.
        </p>
      )}
      {error && <ErrorNotice error={error} />}
      <div className="form-actions">
        <span className="muted">{views.length}/12 views · millimetres</span>
        <button
          className="primary"
          disabled={
            busy ||
            cap?.provider !== "claude" ||
            task.status === "awaiting_input"
          }
        >
          {busy
            ? "Preparing…"
            : objective === "gripper"
              ? "Design gripper"
              : "Generate object CAD"}
          <ArrowRight size={16} />
        </button>
      </div>
    </form>
  );
}
