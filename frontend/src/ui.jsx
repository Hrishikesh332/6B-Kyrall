import { useEffect, useRef, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import {
  AlertCircle,
  ArrowUp,
  Archive,
  Box,
  Check,
  ChevronRight,
  File,
  FileText,
  Image,
  FileArchive,
  Paperclip,
  Plus,
  X,
} from "lucide-react";
import { date, modeLabel, size, statusLabel } from "./lib.js";

export function Animated({ children, className = "", ...props }) {
  const [parent] = useAutoAnimate();
  return (
    <div ref={parent} className={className} {...props}>
      {children}
    </div>
  );
}
export function Badge({ status }) {
  return (
    <span className={`badge ${status}`}>
      <span className="status-dot" />
      {statusLabel(status)}
    </span>
  );
}
export function IconButton({ label, children, ...props }) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}
export function Empty({ icon: Icon = Box, title, children, action }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={24} />
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function Loading({ children = "Loading workspace…" }) {
  return (
    <div className="loading" role="status">
      <span className="status-dot" />
      {children}
    </div>
  );
}
export function ErrorNotice({ error, retry }) {
  return (
    <div className="error-notice" role="alert">
      <AlertCircle size={18} />
      <span>{error.message || error}</span>
      {retry && (
        <button className="secondary" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
export function PageHeading({
  eyebrow = "WORKSPACE",
  title,
  description,
  action,
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow !== "WORKSPACE" && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function Dialog({ title, onClose, children }) {
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    ref.current.showModal();
    return () => {
      previous?.focus?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close.current();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-heading">
          <h2 id="dialog-title">{title}</h2>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={19} />
          </IconButton>
        </div>
        {children}
      </div>
    </dialog>
  );
}
export function FormDialog({
  title,
  onClose,
  onSubmit,
  children,
  submitLabel = "Save",
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const submitting = useRef(false);
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (submitting.current) return;
          const data = Object.fromEntries(new FormData(e.currentTarget));
          submitting.current = true;
          setBusy(true);
          setError(null);
          try {
            await onSubmit(data);
            onClose();
          } catch (err) {
            setError(err);
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        {children}
        {error && <ErrorNotice error={error} />}
        <div className="form-actions">
          <button className="secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
export function Composer({
  initial = false,
  projects = [],
  cap,
  onSubmit,
  onUpload,
  disabled = false,
  projectId = "",
  draft,
  onDraftUsed,
  contextScope,
}) {
  const [text, setText] = useState("");
  const [scope, setScope] = useState(projectId ? "project" : "isolated");
  const [project, setProject] = useState(projectId);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const ref = useRef(null),
    locked = useRef(false);
  useEffect(() => {
    if (draft) {
      setText(draft);
      ref.current?.focus();
      onDraftUsed?.();
    }
  }, [draft, onDraftUsed]);
  useEffect(() => {
    setProject(projectId);
    setScope(projectId ? "project" : "isolated");
  }, [projectId]);
  const submit = async (e) => {
    e.preventDefault();
    if (locked.current || disabled || !text.trim()) return;
    if (scope === "project" && !project) {
      setError(new Error("Choose a project to use project context."));
      return;
    }
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        prompt: text.trim(),
        project_id: project || null,
        context_scope: scope,
      });
      setText("");
    } catch (err) {
      setError(err);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return (
    <div>
      <form
        className={`composer ${initial ? "initial" : ""}`}
        onSubmit={submit}
      >
        <textarea
          ref={ref}
          aria-label={initial ? "Describe your project" : "Message 6B"}
          placeholder={
            initial
              ? "Describe what you want to make…"
              : "Ask a follow-up or describe a change…"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={24000}
          rows={initial ? 4 : 3}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              e.currentTarget.form.requestSubmit();
            }
          }}
        />
        <div className="composer-footer">
          {!initial && (
            <IconButton label="Attach a file" onClick={onUpload}>
              <Paperclip size={18} />
            </IconButton>
          )}
          {initial ? (
            <div className="context-controls">
              <select
                aria-label="Memory scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="isolated">Isolated context</option>
                {project && <option value="project">Project context</option>}
                <option value="workspace">Workspace context</option>
              </select>
            </div>
          ) : (
            <small className="muted">{contextScope} context</small>
          )}
          <span className="composer-model">
            <span className="status-dot" />
            {modeLabel(cap)}
          </span>
          <button
            className="send"
            type="submit"
            disabled={busy || disabled || !text.trim()}
            aria-label="Send message"
          >
            {initial ? (
              <>
                <Plus size={16} />
                Create project
              </>
            ) : (
              <ArrowUp size={20} />
            )}
          </button>
        </div>
      </form>
      {error && <ErrorNotice error={error} />}
    </div>
  );
}
export function ArtifactCard({ artifact: a, onOpen }) {
  return (
    <button className="artifact-card" onClick={() => onOpen(a.task_id, a.id)}>
      <div className="artifact-top">
        <span className="file-type">
          {a.name.split(".").at(-1).toUpperCase()}
        </span>
        {a.metadata.validation_passed && (
          <span className="checked">
            <Check size={12} />
            Checked
          </span>
        )}
      </div>
      <div className="artifact-name">
        <File size={17} />
        <strong>{a.name}</strong>
      </div>
      <small>
        {size(a.size)}
        <span>·</span>Version {a.version}
        <ChevronRight size={15} />
      </small>
    </button>
  );
}
export function TaskRows({ tasks, onOpen, onArchive, onRestore }) {
  return (
    <div className="task-table">
      <div className="table-header">
        <span>Task</span>
        <span>Status</span>
        <span>Updated</span>
        <span />
      </div>
      <Animated>
        {tasks.map((t) => (
          <div className="task-row" key={t.id}>
            <button className="task-title" onClick={() => onOpen(t.id)}>
              <span className="task-icon">
                <Box size={17} />
              </span>
              <span>
                <strong>{t.title}</strong>
              </span>
            </button>
            <Badge status={t.status} />
            <time>{date(t.updated_at)}</time>
            {onArchive || onRestore ? (
              <IconButton
                label={onRestore ? `Restore ${t.title}` : `Archive ${t.title}`}
                onClick={() => (onRestore || onArchive)(t.id)}
              >
                {onRestore ? <Plus size={16} /> : <Archive size={16} />}
              </IconButton>
            ) : (
              <ChevronRight size={16} className="muted" />
            )}
          </div>
        ))}
      </Animated>
    </div>
  );
}

export function ArtifactRows({ artifacts, onOpen }) {
  return (
    <div className="file-table">
      <div className="file-table-heading" aria-hidden="true">
        <span>Name</span>
        <span>Type</span>
        <span>Size</span>
        <span>Version</span>
        <span />
      </div>
      <ul className="file-list">
        {artifacts.map((file) => {
          const extension = file.name.split(".").at(-1).toUpperCase();
          const Icon = ["STEP", "STL", "STP", "OBJ", "3MF"].includes(extension)
            ? Box
            : ["SVG", "PNG", "JPG", "JPEG", "WEBP"].includes(extension)
              ? Image
              : extension === "ZIP"
                ? FileArchive
                : FileText;
          return (
            <li key={file.id}>
              <button
                className="file-row"
                onClick={() => onOpen(file.task_id, file.id)}
                aria-label={`Preview ${file.name}`}
              >
                <span className="file-row-name">
                  <span className="file-row-icon">
                    <Icon size={19} strokeWidth={1.6} />
                  </span>
                  <span>
                    <strong>{file.name}</strong>
                    <small>
                      {file.metadata?.validation_passed ? (
                        <>
                          <Check size={11} />
                          Checked
                        </>
                      ) : (
                        "Download available"
                      )}
                    </small>
                  </span>
                </span>
                <span className="file-type">{extension}</span>
                <span className="file-row-size">{size(file.size)}</span>
                <span className="file-row-version">v{file.version}</span>
                <ChevronRight size={15} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
