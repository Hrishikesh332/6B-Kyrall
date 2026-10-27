import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Box,
  Boxes,
  Check,
  ExternalLink,
  FolderOpen,
  Import,
  KeyRound,
  Plug,
  RefreshCw,
  Search,
  Unplug,
  Upload,
} from "lucide-react";
import { api } from "./lib.js";
import { Dialog, ErrorNotice, Loading } from "./ui.jsx";

// Onshape is read-only here: browse, then import geometry into a task.
export default function OnshapeSetup({
  onClose,
  onChanged,
  onImported,
  notify,
  view = "status",
  taskId,
}) {
  const [status, setStatus] = useState(null),
    [error, setError] = useState(null),
    [screen, setScreen] = useState(view);
  const load = async () => {
    setError(null);
    try {
      setStatus(await api("/integrations/onshape"));
    } catch (err) {
      setError(err);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const connected = status?.configured;
  return (
    <Dialog
      title={
        screen === "browse" && connected
          ? taskId
            ? "Import from Onshape into this project"
            : "Import from Onshape"
          : "Onshape"
      }
      onClose={onClose}
    >
      <div className="onshape-setup">
        {error ? (
          <ErrorNotice error={error} retry={load} />
        ) : !status ? (
          <Loading>Checking connection…</Loading>
        ) : screen === "browse" && connected ? (
          <OnshapeBrowser
            status={status}
            taskId={taskId}
            onBack={view === "browse" ? null : () => setScreen("status")}
            onImported={onImported}
            notify={notify}
          />
        ) : connected ? (
          <Connected
            status={status}
            onBrowse={() => setScreen("browse")}
            onStatus={setStatus}
            onChanged={onChanged}
            onClose={onClose}
            notify={notify}
          />
        ) : (
          <ConnectForm
            onConnected={async (next) => {
              setStatus(next);
              await onChanged?.();
              notify?.(`Onshape connected as ${next.user?.name}.`);
              setScreen("browse");
            }}
            onClose={onClose}
          />
        )}
      </div>
    </Dialog>
  );
}

function Summary({ status, children }) {
  return (
    <div className="connection-summary">
      <span className="connection-icon">
        <Plug size={24} strokeWidth={1.5} />
      </span>
      <div>
        <strong>Onshape</strong>
        <span>
          {status?.configured
            ? `${status.user?.name || "Connected"}${status.user?.email ? ` · ${status.user.email}` : ""}`
            : "Cloud CAD workspace"}
        </span>
      </div>
      <span
        className={`connection-status${status?.configured ? " is-connected" : ""}`}
      >
        {children}
      </span>
    </div>
  );
}

function ConnectForm({ onConnected, onClose }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await onConnected(
        await api("/integrations/onshape", {
          method: "PUT",
          body: {
            base_url: form.get("base_url"),
            access_key: form.get("access_key"),
            secret_key: form.get("secret_key"),
          },
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="onshape-connect">
      <Summary status={null}>Not connected</Summary>
      <ol className="connect-steps">
        <li>
          Create an API key in the Onshape developer portal with{" "}
          <strong>Read</strong> access, plus <strong>Write</strong> if you want
          to send designs back.{" "}
          <a
            href="https://dev-portal.onshape.com/keys"
            target="_blank"
            rel="noreferrer"
          >
            Open API keys <ArrowUpRight size={12} />
          </a>
        </li>
        <li>Paste the access key and secret key below.</li>
        <li>Browse your documents and import a Part Studio or Assembly.</li>
      </ol>
      <label>
        Onshape address
        <input
          name="base_url"
          defaultValue="https://cad.onshape.com"
          required
          autoComplete="off"
          spellCheck={false}
        />
        <small>
          Use your company address if you sign in at company.onshape.com.
        </small>
      </label>
      <label>
        Access key
        <input
          name="access_key"
          required
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label>
        Secret key
        <input
          name="secret_key"
          type="password"
          required
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error.message}
        </p>
      )}
      <p className="connect-note">
        <KeyRound size={13} /> Keys are checked with Onshape, then stored only
        in this workspace’s local data folder. 6B reads documents, and only
        writes when you send a STEP file to Onshape (that needs Write access).
      </p>
      <div className="form-actions">
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" disabled={busy}>
          {busy ? "Checking keys…" : "Connect Onshape"}
        </button>
      </div>
    </form>
  );
}

function Connected({ status, onBrowse, onStatus, onChanged, onClose, notify }) {
  const [busy, setBusy] = useState(""),
    [check, setCheck] = useState(null);
  const run = async (kind, work) => {
    setBusy(kind);
    try {
      await work();
    } catch (err) {
      setCheck({ ok: false, message: err.message });
    } finally {
      setBusy("");
    }
  };
  const fromEnv = status.source === "environment";
  return (
    <>
      <Summary status={status}>
        <Check size={11} /> Connected
      </Summary>
      <dl className="connection-facts">
        <div>
          <dt>Workspace</dt>
          <dd>{status.base_url.replace("https://", "")}</dd>
        </div>
        <div>
          <dt>Access key</dt>
          <dd>{status.access_key_hint}</dd>
        </div>
        <div>
          <dt>Stored in</dt>
          <dd>{fromEnv ? "Environment variables" : "Local workspace data"}</dd>
        </div>
      </dl>
      {check && (
        <p className={`connection-check${check.ok ? " ok" : ""}`} role="status">
          {check.message}
        </p>
      )}
      <div className="onshape-actions">
        <button className="primary" onClick={onBrowse}>
          <FolderOpen size={15} /> Browse & import designs
        </button>
        <button
          className="secondary"
          disabled={!!busy}
          onClick={() =>
            run("test", async () => {
              const next = await api("/integrations/onshape/test", {
                method: "POST",
              });
              onStatus(next);
              setCheck({
                ok: true,
                message: `Connection works. Signed in as ${next.user?.name}.`,
              });
            })
          }
        >
          <RefreshCw size={14} />
          {busy === "test" ? "Checking…" : "Test connection"}
        </button>
        <a
          className="secondary"
          href={status.base_url}
          target="_blank"
          rel="noreferrer"
        >
          Open Onshape <ExternalLink size={14} />
        </a>
        {!fromEnv && (
          <button
            className="secondary danger-text"
            disabled={!!busy}
            onClick={() =>
              run("disconnect", async () => {
                onStatus(
                  await api("/integrations/onshape", { method: "DELETE" }),
                );
                await onChanged?.();
                notify?.(
                  "Onshape disconnected. Imported files stay in your tasks.",
                );
                onClose();
              })
            }
          >
            <Unplug size={14} /> Disconnect
          </button>
        )}
      </div>
    </>
  );
}

const FILTERS = [
  [5, "Recent"],
  [0, "My documents"],
  [2, "Shared with me"],
];
const thumbnails = new Map();

function Thumbnail({ did, wid, eid, icon: Icon = Box }) {
  const key = `${did}/${wid}/${eid || ""}`;
  const [url, setUrl] = useState(thumbnails.get(key));
  useEffect(() => {
    if (thumbnails.has(key)) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ did, wid, ...(eid ? { eid } : {}) });
    api(`/onshape/thumbnail?${params}`, {
      raw: true,
      signal: controller.signal,
    })
      .then((r) => r.blob())
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        thumbnails.set(key, objectUrl);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) thumbnails.set(key, null);
      });
    return () => controller.abort();
  }, [key]);
  return url ? (
    <img src={url} alt="" loading="lazy" />
  ) : (
    <span className="thumb-fallback">
      <Icon size={22} strokeWidth={1.4} />
    </span>
  );
}

function OnshapeBrowser({ status, taskId, onBack, onImported, notify }) {
  const [error, setError] = useState(null),
    [doc, setDoc] = useState(null),
    [elements, setElements] = useState(null),
    [element, setElement] = useState(null);
  const [prompt, setPrompt] = useState(""),
    [importing, setImporting] = useState(false),
    [importError, setImportError] = useState(null);
  useEffect(() => {
    if (!doc) return;
    const controller = new AbortController();
    setElements(null);
    setElement(null);
    api(`/onshape/documents/${doc.id}/w/${doc.workspace_id}/elements`, {
      signal: controller.signal,
    })
      .then(setElements)
      .catch((err) => !controller.signal.aborted && setError(err));
    return () => controller.abort();
  }, [doc]);
  const submit = async () => {
    setImporting(true);
    setImportError(null);
    try {
      const result = await api("/onshape/import", {
        method: "POST",
        body: {
          document_id: doc.id,
          workspace_id: doc.workspace_id,
          element_id: element.id,
          ...(taskId ? { task_id: taskId } : {}),
          prompt,
        },
      });
      notify?.(
        `Imported ${result.parts} part${result.parts === 1 ? "" : "s"} from ${element.name}.`,
      );
      await onImported?.(result);
    } catch (err) {
      setImportError(err);
    } finally {
      setImporting(false);
    }
  };
  if (doc)
    return (
      <div className="onshape-browser">
        <button className="text-button" onClick={() => setDoc(null)}>
          <ArrowLeft size={14} /> All documents
        </button>
        <div className="onshape-doc-heading">
          <h3>{doc.name}</h3>
          <a href={doc.url} target="_blank" rel="noreferrer">
            Open in Onshape <ExternalLink size={12} />
          </a>
        </div>
        {error && <ErrorNotice error={error} />}
        {!elements && !error && <Loading>Loading tabs…</Loading>}
        {elements && !elements.length && (
          <p className="muted">
            This document has no Part Studios or Assemblies to import.
          </p>
        )}
        {elements && elements.length > 0 && (
          <div
            className="onshape-grid elements"
            role="radiogroup"
            aria-label="Part Studios and Assemblies"
          >
            {elements.map((e) => (
              <button
                key={e.id}
                role="radio"
                aria-checked={element?.id === e.id}
                className="onshape-card"
                onClick={() => setElement(e)}
              >
                <span className="onshape-thumb">
                  <Thumbnail
                    did={doc.id}
                    wid={doc.workspace_id}
                    eid={e.id}
                    icon={e.type === "ASSEMBLY" ? Boxes : Box}
                  />
                </span>
                <strong>{e.name}</strong>
                <small>
                  {e.type === "ASSEMBLY" ? "Assembly" : "Part Studio"}
                </small>
              </button>
            ))}
          </div>
        )}
        {element && (
          <div className="onshape-import-panel">
            <p>
              Imports every visible part of <strong>{element.name}</strong> as
              STL files, with a 3D preview that keeps the{" "}
              {element.type === "ASSEMBLY"
                ? "assembly placements"
                : "Part Studio layout"}
              .{" "}
              {taskId
                ? "They’re added to this project."
                : "A new project is created for them."}
            </p>
            <label>
              What should 6B do with it? (optional)
              <textarea
                rows={2}
                maxLength={8000}
                value={prompt}
                placeholder="e.g. Design a mounting bracket that fits this assembly"
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
            {importError && (
              <p className="form-error" role="alert">
                {importError.message}
              </p>
            )}
            <button className="primary" disabled={importing} onClick={submit}>
              <Import size={15} />
              {importing
                ? "Importing parts…"
                : prompt.trim()
                  ? "Import and start"
                  : "Import"}
            </button>
            <small>
              A read-only snapshot of the current workspace. Features, mates and
              parameters stay in Onshape.
            </small>
          </div>
        )}
      </div>
    );
  return (
    <div className="onshape-browser">
      {onBack && (
        <button className="text-button" onClick={onBack}>
          <ArrowLeft size={14} /> Connection
        </button>
      )}
      <DocumentPicker status={status} onPick={setDoc} />
    </div>
  );
}

// Searchable, paged list of the user's Onshape documents.
function DocumentPicker({ status, onPick, selectedId }) {
  const [filter, setFilter] = useState(5),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0);
  const [documents, setDocuments] = useState(null),
    [error, setError] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    setDocuments(null);
    setError(null);
    const params = new URLSearchParams({ q: search, filter, offset });
    api(`/onshape/documents?${params}`, { signal: controller.signal })
      .then(setDocuments)
      .catch((err) => !controller.signal.aborted && setError(err));
    return () => controller.abort();
  }, [filter, search, offset]);
  return (
    <>
      <form
        className="onshape-search"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setSearch(query.trim());
        }}
      >
        <div className="search-field">
          <Search size={15} />
          <input
            aria-label="Search Onshape documents"
            placeholder={`Search ${status.base_url.replace("https://", "")}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="secondary">Search</button>
      </form>
      <div
        className="catalog-filters"
        role="group"
        aria-label="Document filter"
      >
        {FILTERS.map(([id, name]) => (
          <button
            key={id}
            aria-pressed={filter === id}
            onClick={() => {
              setFilter(id);
              setOffset(0);
            }}
          >
            {name}
          </button>
        ))}
      </div>
      {error && <ErrorNotice error={error} />}
      {!documents && !error && <Loading>Loading documents…</Loading>}
      {documents && !documents.items.length && (
        <p className="muted">
          {search
            ? "No documents match that search."
            : "No documents here yet."}
        </p>
      )}
      {documents && documents.items.length > 0 && (
        <div className="onshape-grid">
          {documents.items.map((d) => (
            <button
              key={d.id}
              className="onshape-card"
              aria-pressed={selectedId ? selectedId === d.id : undefined}
              onClick={() => onPick(d)}
            >
              <span className="onshape-thumb">
                <Thumbnail did={d.id} wid={d.workspace_id} />
              </span>
              <strong>{d.name}</strong>
              <small>
                {[
                  d.owner,
                  d.modified_at &&
                    new Date(d.modified_at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </button>
          ))}
        </div>
      )}
      {documents && (documents.offset > 0 || documents.next) && (
        <div className="onshape-pages">
          <button
            className="secondary"
            disabled={!documents.offset}
            onClick={() => setOffset((o) => Math.max(0, o - 20))}
          >
            Previous
          </button>
          <button
            className="secondary"
            disabled={!documents.next}
            onClick={() => setOffset((o) => o + 20)}
          >
            Next
          </button>
        </div>
      )}
    </>
  );
}

// Upload a generated STEP file; Onshape translates it into a Part Studio.
export function OnshapeExport({
  taskId,
  artifactId,
  name,
  title,
  onClose,
  onConnect,
}) {
  const [status, setStatus] = useState(null),
    [error, setError] = useState(null),
    [target, setTarget] = useState("new"),
    [doc, setDoc] = useState(null),
    [docName, setDocName] = useState(title || name.replace(/\.[^.]+$/, "")),
    [flatten, setFlatten] = useState(true),
    [sending, setSending] = useState(false),
    [result, setResult] = useState(null);
  useEffect(() => {
    api("/integrations/onshape").then(setStatus).catch(setError);
  }, []);
  const send = async () => {
    setSending(true);
    setError(null);
    try {
      setResult(
        await api("/onshape/export", {
          method: "POST",
          body: {
            task_id: taskId,
            artifact_id: artifactId,
            flatten,
            ...(target === "new"
              ? { new_document_name: docName.trim() }
              : { document_id: doc.id, workspace_id: doc.workspace_id }),
          },
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setSending(false);
    }
  };
  return (
    <Dialog title="Send to Onshape" onClose={onClose}>
      <div className="onshape-setup onshape-export">
        {!status && !error ? (
          <Loading>Checking connection…</Loading>
        ) : status && !status.configured ? (
          <>
            <Summary status={status}>Not connected</Summary>
            <p>
              Connect Onshape with API keys that have Write access to send
              files.
            </p>
            <div className="form-actions">
              <button className="secondary" onClick={onClose}>
                Cancel
              </button>
              <button className="primary" onClick={onConnect}>
                Set up connection
              </button>
            </div>
          </>
        ) : result ? (
          <div className="export-result" role="status">
            <Summary status={status}>
              <Check size={11} />
              {result.state === "done" ? "Imported" : "Translating"}
            </Summary>
            <p>
              {result.state === "done"
                ? `${result.file} is now ${result.elements.length ? `the Part Studio “${result.elements[0].name}”` : "in the document"}${result.created_document ? " in a new Onshape document" : ""}.`
                : `${result.file} was uploaded. Onshape is still translating it; it will appear in the document shortly.`}
            </p>
            <div className="form-actions">
              <button className="secondary" onClick={onClose}>
                Done
              </button>
              <a
                className="primary"
                href={result.url}
                target="_blank"
                rel="noreferrer"
              >
                Open in Onshape <ExternalLink size={14} />
              </a>
            </div>
          </div>
        ) : (
          <>
            <p className="export-file">
              <Upload size={14} /> <strong>{name}</strong> becomes an editable
              Part Studio in Onshape. Nothing existing is changed.
            </p>
            <div className="segmented" role="group" aria-label="Destination">
              <button
                aria-pressed={target === "new"}
                onClick={() => setTarget("new")}
              >
                New document
              </button>
              <button
                aria-pressed={target === "existing"}
                onClick={() => setTarget("existing")}
              >
                Existing document
              </button>
            </div>
            {target === "new" ? (
              <label className="export-field">
                Document name
                <input
                  value={docName}
                  maxLength={100}
                  onChange={(e) => setDocName(e.target.value)}
                />
              </label>
            ) : (
              <div className="onshape-browser">
                <DocumentPicker
                  status={status}
                  onPick={setDoc}
                  selectedId={doc?.id}
                />
              </div>
            )}
            <label className="inline-check">
              <input
                type="checkbox"
                checked={flatten}
                onChange={(e) => setFlatten(e.target.checked)}
              />
              Put all parts in one Part Studio (otherwise keep the assembly)
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error.message}
              </p>
            )}
            <div className="form-actions">
              <button className="secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={
                  sending || (target === "new" ? !docName.trim() : !doc)
                }
                onClick={send}
              >
                {sending
                  ? "Uploading and translating…"
                  : target === "new"
                    ? "Create document and send"
                    : `Send to ${doc ? doc.name : "document"}`}
              </button>
            </div>
            {sending && (
              <small className="export-wait">
                Onshape translates STEP files on its servers; this can take up
                to a couple of minutes.
              </small>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
