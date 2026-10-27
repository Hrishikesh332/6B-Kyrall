import { useEffect, useRef, useState } from "react";
import { Box, Download, ExternalLink, X } from "lucide-react";
import { api, size } from "./lib.js";
import { useResource } from "./hooks.js";
import { ModelThumbnail } from "./FileLibrary.jsx";
import { MeshPreview } from "./ArtifactPreview.jsx";
import { Empty, ErrorNotice, Loading } from "./ui.jsx";
import "./sample-meshes.css";

function SampleCard({ sample, onOpen }) {
  const [failed, setFailed] = useState(false);
  return (
    <article className="preview-card">
      <button
        className="preview-card-open"
        aria-label={`Preview ${sample.name}`}
        onClick={onOpen}
      >
        <div className="file-thumbnail kind-models" aria-hidden="true">
          {failed ? (
            <Box size={42} strokeWidth={1} />
          ) : (
            <ModelThumbnail
              file={{ id: sample.id, name: sample.filename }}
              sourcePath={`/mesh-samples/${sample.id}/preview`}
              onError={() => setFailed(true)}
            />
          )}
          <span className="thumbnail-format">GLB · CC0</span>
        </div>
        <span className="preview-card-caption">
          <span className="file-glyph kind-models">
            <Box size={18} strokeWidth={1.5} />
          </span>
          <span className="preview-card-name">
            <strong>{sample.name}</strong>
            <small>{sample.description}</small>
          </span>
        </span>
      </button>
    </article>
  );
}

export function SamplePreview({ sample, onClose }) {
  const panel = useRef(null),
    closeButton = useRef(null);
  const resource = useResource(`/mesh-samples/${sample.id}/preview`);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  useEffect(() => {
    const previous = document.activeElement,
      overflow = document.body.style.overflow;
    panel.current.showModal();
    document.body.style.overflow = "hidden";
    closeButton.current.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await api(`/mesh-samples/${sample.id}/original`, {
        raw: true,
      });
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = sample.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={panel}
      className="preview-panel has-model sample-preview"
      aria-labelledby="sample-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="preview-header">
        <div className="preview-identity">
          <Box size={22} />
          <div>
            <span className="eyebrow">SAMPLE MESH</span>
            <h2 id="sample-title">{sample.name}</h2>
          </div>
        </div>
        <button
          ref={closeButton}
          className="icon-button"
          aria-label="Close preview"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <div className="preview-controls">
        <span className="sample-stats">
          {sample.triangles.toLocaleString()} triangles · {sample.parts}{" "}
          {sample.parts === 1 ? "part" : "parts"}
        </span>
        <button className="secondary" onClick={download} disabled={busy}>
          <Download size={15} />
          {busy ? "Preparing…" : "Download GLB"}
        </button>
      </div>
      {error && <ErrorNotice error={error} />}
      <div className="preview-body">
        {resource.loading ? (
          <Loading>Loading model…</Loading>
        ) : resource.error ? (
          <ErrorNotice error={resource.error} retry={resource.reload} />
        ) : (
          <MeshPreview mesh={resource.data} name={sample.filename} />
        )}
        <div className="sample-provenance">
          <p>{sample.preview_note}</p>
          <div>
            <span>{sample.author}</span>
            <a href={sample.source_url} target="_blank" rel="noreferrer">
              Khronos source <ExternalLink size={12} />
            </a>
            <a href={sample.license_url} target="_blank" rel="noreferrer">
              {sample.license}
            </a>
            <span>{size(sample.size)}</span>
          </div>
          <details>
            <summary>Model details</summary>
            <p>
              Source dimensions: {sample.bounds_mm.join(" × ")} mm. Geometry is
              shown at the source scale; printability has not been checked.
            </p>
            <p>
              Preview conversion: scene transforms applied; metres converted to
              millimetres; Y-up rotated to Z-up. Textures, animation and
              material effects are not rendered here.
            </p>
          </details>
        </div>
      </div>
    </dialog>
  );
}

export default function SampleMeshes() {
  const resource = useResource("/mesh-samples");
  const [selected, setSelected] = useState(null);
  return (
    <section className="sample-library" aria-label="Sample meshes">
      <div className="sample-library-intro">
        <h2>Explore a model</h2>
        <p>
          Openly licensed models from Khronos. Ready to explore and download,
          even offline.
        </p>
      </div>
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <ErrorNotice error={resource.error} retry={resource.reload} />
      ) : resource.data.length ? (
        <div className="file-gallery">
          {resource.data.map((sample) => (
            <SampleCard
              key={sample.id}
              sample={sample}
              onOpen={() => setSelected(sample)}
            />
          ))}
        </div>
      ) : (
        <Empty title="No sample meshes available" />
      )}
      {selected && (
        <SamplePreview sample={selected} onClose={() => setSelected(null)} />
      )}
    </section>
  );
}
