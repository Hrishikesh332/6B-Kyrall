import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  Download,
  FileArchive,
  FileCode2,
  FileText,
  Image,
  LayoutGrid,
  List,
  Play,
  Layers,
} from "lucide-react";
import { api, size } from "./lib.js";
import { renderText } from "../format.js";
import { mountViewer } from "../viewer.js";
import { ArtifactRows } from "./ui.jsx";
import {
  downloadArtifact,
  extensionOf,
  fileDescription,
  fileKind,
  sortFiles,
  thumbnailSource,
} from "./filePresentation.js";

export function FileIcon({ file, ...props }) {
  const kind = fileKind(file);
  const Icon =
    { models: Box, images: Image, packages: FileArchive, media: Play }[kind] ||
    (extensionOf(file) === "json" ? FileCode2 : FileText);
  return <Icon {...props} />;
}

export function ModelThumbnail({ file, meshFile, sourcePath, onError }) {
  const canvas = useRef(null);
  const [snapshot, setSnapshot] = useState(null);
  useEffect(() => {
    const controller = new AbortController(),
      target = canvas.current;
    let renderer,
      objectUrl,
      capturing = false,
      released = false;
    const release = () => {
      if (released || !renderer) return;
      released = true;
      renderer.destroy();
      target
        .getContext("webgl")
        ?.getExtension("WEBGL_lose_context")
        ?.loseContext();
    };
    api(
      sourcePath ||
        `/tasks/${meshFile.task_id}/artifacts/${meshFile.id}/content`,
      {
        raw: true,
        signal: controller.signal,
      },
    )
      .then((response) => response.json())
      .then((mesh) => {
        if (controller.signal.aborted) return;
        renderer = mountViewer(target, mesh, {
          still: true,
          onRender: () => {
            if (capturing) return;
            capturing = true;
            try {
              target.toBlob((blob) => {
                if (!controller.signal.aborted) {
                  if (blob) {
                    objectUrl = URL.createObjectURL(blob);
                    setSnapshot(objectUrl);
                  } else onError();
                }
                release();
              }, "image/png");
            } catch {
              onError();
              release();
            }
          },
        });
        const part = mesh.parts.find(
          (part) => `${part.name}.stl` === file.name,
        );
        if (part)
          renderer.update({
            hidden: mesh.parts
              .filter((item) => item !== part)
              .map((item) => item.name),
          });
      })
      .catch(() => {
        if (!controller.signal.aborted) onError();
      });
    return () => {
      controller.abort();
      release();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id, meshFile?.id, sourcePath]);
  return snapshot ? (
    <img
      className="model-thumbnail-image"
      src={snapshot}
      alt=""
      onError={onError}
    />
  ) : (
    <canvas className="model-thumbnail-canvas" ref={canvas} />
  );
}

function FileThumbnail({ file, allFiles }) {
  const root = useRef(null);
  const [visible, setVisible] = useState(false);
  const [content, setContent] = useState(null);
  const [meshFailed, setMeshFailed] = useState(false);
  const source = thumbnailSource(file, allFiles);
  const meshFile =
    fileKind(file) === "models" &&
    !meshFailed &&
    file.metadata?.build_id &&
    allFiles.find(
      (other) =>
        other.task_id === file.task_id &&
        other.metadata?.build_id === file.metadata.build_id &&
        other.metadata?.kind === "mesh_preview",
    );
  const textPreview =
    ["md", "txt", "json", "csv"].includes(extensionOf(file)) &&
    file.size <= 300000 &&
    file.metadata?.kind !== "mesh_preview";
  useEffect(() => {
    if (!globalThis.IntersectionObserver) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || meshFile || (!source && !textPreview)) return;
    const controller = new AbortController();
    let url;
    setContent(null);
    const selected = source || file;
    api(`/tasks/${selected.task_id}/artifacts/${selected.id}/content`, {
      raw: true,
      signal: controller.signal,
    })
      .then(async (response) => {
        if (source) {
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          url = URL.createObjectURL(blob);
          setContent({ image: url });
        } else {
          const text = await response.text();
          if (!controller.signal.aborted)
            setContent({ text: text.slice(0, 1800) });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setContent({ unavailable: true });
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [visible, source?.id, file.id, textPreview, !!meshFile]);
  const manifest = file.metadata?.manifest;
  return (
    <div
      ref={root}
      className={`file-thumbnail kind-${fileKind(file)} ${content?.image ? "has-image" : ""}`}
      aria-hidden="true"
    >
      {visible && meshFile ? (
        <ModelThumbnail
          file={file}
          meshFile={meshFile}
          onError={() => setMeshFailed(true)}
        />
      ) : content?.image ? (
        <img
          src={content.image}
          alt=""
          onError={() => setContent({ unavailable: true })}
        />
      ) : content?.text !== undefined ? (
        <div
          className={`thumbnail-document ${extensionOf(file) === "md" ? "is-markdown" : "is-code"}`}
        >
          {extensionOf(file) === "md" ? (
            <div
              dangerouslySetInnerHTML={{ __html: renderText(content.text) }}
            />
          ) : (
            <pre>{content.text}</pre>
          )}
        </div>
      ) : manifest?.length ? (
        <div className="thumbnail-package">
          <FileArchive size={30} strokeWidth={1.3} />
          <strong>{manifest.length} files, together</strong>
          {manifest.slice(0, 3).map((item) => (
            <span key={item.id}>{item.name}</span>
          ))}
        </div>
      ) : (
        <div className="thumbnail-symbol">
          <FileIcon file={file} size={42} strokeWidth={1} />
          <span>{fileDescription(file)}</span>
        </div>
      )}
      <span className="thumbnail-format">
        {extensionOf(file).toUpperCase()}
      </span>
      {file.metadata?.source === "onshape" && (
        <span className="thumbnail-source">Onshape</span>
      )}
      {!meshFile && source && source.id !== file.id && (
        <span className="thumbnail-caption">Assembly preview</span>
      )}
    </div>
  );
}

function PreviewCard({ file, allFiles, onOpen, notify }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <article className="preview-card">
      <button
        className="preview-card-open"
        aria-label={`Preview ${file.name}`}
        onClick={() => onOpen(file.task_id, file.id)}
      >
        <FileThumbnail file={file} allFiles={allFiles} />
        <span className="preview-card-caption">
          <span className={`file-glyph kind-${fileKind(file)}`}>
            <FileIcon file={file} size={18} strokeWidth={1.5} />
          </span>
          <span className="preview-card-name">
            <strong title={file.name}>{file.name}</strong>
            <small>
              {size(file.size)} <span>·</span> v{file.version}
              {file.metadata?.validation_passed && (
                <Check size={11} aria-label="Geometry checked" />
              )}
            </small>
          </span>
        </span>
      </button>
      <button
        className="icon-button card-download"
        aria-label={`Download ${file.name}`}
        title={`Download ${file.name}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await downloadArtifact(file);
          } catch (err) {
            setError(err.message);
            notify?.(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Download size={15} />
      </button>
      {error && (
        <p className="card-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

export function FileGallery({ files, allFiles = files, onOpen, notify }) {
  return (
    <div className="file-gallery">
      {files.map((file) => (
        <PreviewCard
          key={file.id}
          file={file}
          allFiles={allFiles}
          onOpen={onOpen}
          notify={notify}
        />
      ))}
    </div>
  );
}
function FileGroup({ title, taskId, files, allFiles, layout, onOpen, notify }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded || layout === "list" ? files : files.slice(0, 6);
  return (
    <section className="file-group">
      {title && (
        <div className="file-group-heading">
          <a href={`#task=${encodeURIComponent(taskId)}`}>
            {title}
            <ArrowRight size={14} />
          </a>
          <span>
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
        </div>
      )}
      {layout === "grid" ? (
        <FileGallery
          files={visible}
          allFiles={allFiles}
          onOpen={onOpen}
          notify={notify}
        />
      ) : (
        <ArtifactRows artifacts={visible} onOpen={onOpen} />
      )}
      {layout === "grid" && files.length > 6 && (
        <button
          className="show-more-files"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? "Show fewer files"
            : `Show ${files.length - 6} more files`}
          <ChevronDown size={14} />
        </button>
      )}
    </section>
  );
}
export default function FileLibrary({
  files,
  allFiles = files,
  onOpen,
  notify,
  groupByTask = true,
}) {
  const [layout, setLayout] = useState("grid"),
    [sort, setSort] = useState("recommended"),
    [grouped, setGrouped] = useState(groupByTask);
  const ordered = sortFiles(files, sort);
  const groups = new Map();
  for (const file of ordered) {
    const key = grouped ? file.task_id : "all";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  return (
    <div className="file-library">
      <div className="library-toolbar">
        <span className="library-count">
          {files.length} {files.length === 1 ? "file" : "files"}{" "}
          <span>· Latest versions</span>
        </span>
        <div className="library-options">
          <select
            aria-label="Sort files"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="recommended">Preview first</option>
            <option value="recent">Newest first</option>
            <option value="name">Name A–Z</option>
          </select>
          {groupByTask && (
            <button
              className="icon-button"
              title="Group by project"
              aria-label="Group by project"
              aria-pressed={grouped}
              onClick={() => setGrouped((value) => !value)}
            >
              <Layers size={16} />
            </button>
          )}
          <div className="layout-switch" aria-label="File layout">
            <button
              aria-label="Grid view"
              title="Grid view"
              aria-pressed={layout === "grid"}
              onClick={() => setLayout("grid")}
            >
              <LayoutGrid size={16} />
            </button>
            <button
              aria-label="List view"
              title="List view"
              aria-pressed={layout === "list"}
              onClick={() => setLayout("list")}
            >
              <List size={17} />
            </button>
          </div>
        </div>
      </div>
      {[...groups].map(([id, items]) => (
        <FileGroup
          key={`${id}:${sort}`}
          title={grouped ? items[0].task_title || "Project files" : null}
          taskId={id}
          files={items}
          allFiles={allFiles}
          layout={layout}
          onOpen={onOpen}
          notify={notify}
        />
      ))}
    </div>
  );
}
