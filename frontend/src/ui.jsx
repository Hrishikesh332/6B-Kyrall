import { useEffect, useId, useRef, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import {
  AlertCircle,
  ArrowUp,
  Archive,
  ArchiveRestore,
  Box,
  Check,
  ChevronRight,
  File,
  FileText,
  Image,
  FileArchive,
  Paperclip,
  Plug,
  Plus,
  X,
} from "lucide-react";
import {
  cadRefusal,
  date,
  followUpRefusal,
  modelConnected,
  size,
  statusLabel,
} from "./lib.js";
import ModelPicker from "./ModelPicker.jsx";

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
// A destructive button that asks once more in place: the first click changes it to
// `confirm` ("Disconnect?"), a second click within a few seconds runs `onConfirm`.
// Moving focus away or waiting resets it.
export function ConfirmButton({
  children,
  confirm,
  onConfirm,
  className = "secondary danger-text",
  label,
  ...props
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={`${className}${armed ? " confirming" : ""}`}
      aria-label={armed ? confirm : label}
      title={armed ? undefined : label}
      {...props}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? confirm : children}
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
  const titleId = useId();
  // Only a click that starts and ends on the backdrop closes the dialog, so selecting
  // text in a field and releasing outside it keeps what was typed.
  const pressedBackdrop = useRef(false);
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
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === ref.current;
      }}
      onClick={(e) => {
        if (e.target === ref.current && pressedBackdrop.current)
          close.current();
        pressedBackdrop.current = false;
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-heading">
          <h2 id={titleId}>{title}</h2>
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
  busyLabel = "Saving…",
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
            {busy ? busyLabel : submitLabel}
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
  onRefused,
  onUpload,
  disabled = false,
  projectId = "",
  draft,
  onDraftUsed,
  contextScope,
  attachments = null,
  hasAttachments = false,
  onModelChange,
  onConnectModel,
  submitLabel = "Start chat",
  placeholder,
}) {
  const [text, setText] = useState("");
  // Once capabilities are known: without a model, ask for one as soon as the user starts writing.
  const needsModel = !!cap && !!onConnectModel && !modelConnected(cap);
  const asked = useRef(false);
  const askForModel = () => {
    asked.current = true;
    onConnectModel();
  };
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
    if (locked.current || disabled || (!text.trim() && !hasAttachments)) return;
    // A prompt that is not about CAD stops here: nothing is sent and nothing on the page changes.
    const refused = (initial ? cadRefusal : followUpRefusal)(
      text.trim(),
      cap?.cad_scope,
    );
    if (refused) {
      onRefused?.(refused, "warning");
      return;
    }
    if (needsModel) {
      // Keep the draft: it is sent once a model is connected.
      askForModel();
      return;
    }
    if (scope === "project" && !project) {
      setError(new Error("Choose a project to use project context."));
      return;
    }
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const sent = await onSubmit({
        prompt: text.trim(),
        project_id: project || null,
        context_scope: scope,
      });
      // `false` means the prompt was refused and should stay in the box.
      if (sent !== false) setText("");
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
        {attachments}
        <textarea
          ref={ref}
          aria-label={initial ? "Describe your project" : "Message 6B"}
          placeholder={
            placeholder ||
            (initial
              ? "Describe what you want to make…"
              : "Ask a follow-up or describe a change…")
          }
          value={text}
          onFocus={() => {
            if (needsModel && !asked.current) askForModel();
          }}
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
          <ModelPicker
            cap={cap}
            onChange={onModelChange}
            onError={setError}
            followUp={!initial}
          />
          <button
            className="send"
            type="submit"
            disabled={busy || disabled || (!text.trim() && !hasAttachments)}
            aria-label="Send message"
          >
            {initial ? (
              <>
                <Plus size={16} />
                {submitLabel}
              </>
            ) : (
              <ArrowUp size={20} />
            )}
          </button>
        </div>
      </form>
      {needsModel && (
        <button
          type="button"
          className="composer-connect"
          onClick={askForModel}
        >
          <Plug size={14} />
          <span>No model connected.</span>
          <strong>Connect Claude Code or ChatGPT to start</strong>
        </button>
      )}
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
        <span>Chat</span>
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
                {onRestore ? (
                  <ArchiveRestore size={16} />
                ) : (
                  <Archive size={16} />
                )}
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
