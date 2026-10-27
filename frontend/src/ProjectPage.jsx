import { useState } from "react";
import {
  ArrowRight,
  BookOpen,
  File,
  Folder,
  MessageSquare,
  Pencil,
  Plus,
  Settings2,
} from "lucide-react";
import { api, date, size } from "./lib.js";
import { useResource } from "./hooks.js";
import {
  Animated,
  Composer,
  Empty,
  ErrorNotice,
  Loading,
  TaskRows,
} from "./ui.jsx";
import "./project-page.css";

// A project is a folder of chats that share a brief, reference files and memory.
// Chats started here read the project's memory; what they learn is saved back to it.
export default function ProjectPage({
  id,
  cap,
  projects,
  createTask,
  onModelChange,
  openTask,
  setModal,
  notify,
  changed,
  revision,
}) {
  const resource = useResource(`/projects/${id}`, revision, true);
  const project = resource.data;
  if (!project)
    return (
      <div className="page">
        {resource.error ? (
          <ErrorNotice error={resource.error} retry={resource.reload} />
        ) : (
          <Loading>Loading project…</Loading>
        )}
      </div>
    );
  return (
    <div className="page project-page">
      <header className="project-page-heading">
        <span className="project-icon">
          <Folder size={21} strokeWidth={1.6} />
        </span>
        <div>
          <div className="eyebrow">PROJECT</div>
          <h1>{project.name}</h1>
          {project.brief && <p>{project.brief}</p>}
        </div>
        <button
          className="secondary"
          onClick={() => setModal({ kind: "project", project })}
        >
          <Settings2 size={15} />
          Edit project
        </button>
      </header>
      <Composer
        initial
        projects={projects}
        cap={cap}
        onModelChange={onModelChange}
        onConnectModel={() => setModal({ kind: "model" })}
        onSubmit={createTask}
        onRefused={notify}
        projectId={id}
        submitLabel="New chat"
        placeholder={`Start a new chat in ${project.name}…`}
      />
      <div className="project-page-grid">
        <section aria-labelledby="project-chats">
          <h2 id="project-chats">
            <MessageSquare size={16} />
            Chats
            <small>{project.chats.length}</small>
          </h2>
          {project.chats.length ? (
            <TaskRows tasks={project.chats} onOpen={openTask} />
          ) : (
            <Empty icon={MessageSquare} title="No chats yet">
              Chats you start here share this project’s brief, files and memory.
            </Empty>
          )}
        </section>
        <aside className="project-side">
          <ProjectMemory
            project={project}
            openTask={openTask}
            setModal={setModal}
            notify={notify}
            changed={changed}
          />
          <section aria-labelledby="project-files">
            <h2 id="project-files">
              <File size={16} />
              Reference files
              <small>{project.files.length}</small>
            </h2>
            {project.files.length ? (
              <ul className="project-file-list">
                {project.files.map((f) => (
                  <li key={f.id}>
                    <a
                      href={`/api/projects/${id}/files/${f.id}`}
                      download={f.name}
                    >
                      {f.name}
                    </a>
                    <small>{size(f.size)}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                Attach drawings, datasheets or notes from Edit project.
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function ProjectMemory({ project, openTask, setModal, notify, changed }) {
  const [draft, setDraft] = useState(""),
    [editing, setEditing] = useState(null),
    [busy, setBusy] = useState(false);
  const save = async (path, method, content) => {
    setBusy(true);
    try {
      await api(path, { method, body: { content } });
      await changed();
      return true;
    } catch (error) {
      notify(error.message, "error");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    if (await save(`/projects/${project.id}/memories`, "POST", draft)) {
      setDraft("");
      notify("Added to project memory.");
    }
  };
  const update = async (e) => {
    e.preventDefault();
    if (!editing.content.trim()) return;
    if (await save(`/memories/${editing.id}`, "PATCH", editing.content))
      setEditing(null);
  };
  return (
    <section aria-labelledby="project-memory">
      <h2 id="project-memory">
        <BookOpen size={16} />
        Project memory
        <small>{project.memories.length}</small>
      </h2>
      <p className="muted project-memory-hint">
        {project.memory_scope === "workspace"
          ? "Shared with chats here and across the workspace."
          : "Only chats in this project can use it."}
      </p>
      <form className="project-memory-add" onSubmit={add}>
        <textarea
          aria-label="Add to project memory"
          placeholder="Something every chat here should know…"
          value={draft}
          maxLength={4000}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          className="secondary"
          type="submit"
          disabled={busy || !draft.trim()}
        >
          <Plus size={14} />
          Remember
        </button>
      </form>
      <Animated className="project-memory-list">
        {project.memories.map((m) => (
          <article key={m.id}>
            {editing?.id === m.id ? (
              <form onSubmit={update}>
                <textarea
                  aria-label="Edit memory"
                  value={editing.content}
                  maxLength={4000}
                  rows={3}
                  autoFocus
                  onChange={(e) =>
                    setEditing({ ...editing, content: e.target.value })
                  }
                />
                <footer>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </button>
                  <button className="secondary" type="submit" disabled={busy}>
                    Save
                  </button>
                </footer>
              </form>
            ) : (
              <>
                <p>{m.content}</p>
                <footer>
                  {m.task_id ? (
                    <button
                      className="text-button"
                      onClick={() => openTask(m.task_id)}
                    >
                      {m.title}
                      <ArrowRight size={13} />
                    </button>
                  ) : (
                    <small>Your note · {date(m.created_at)}</small>
                  )}
                  <span>
                    <button
                      className="icon-button"
                      aria-label="Edit memory"
                      onClick={() =>
                        setEditing({ id: m.id, content: m.content })
                      }
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setModal({ kind: "forget", id: m.id })}
                    >
                      Forget
                    </button>
                  </span>
                </footer>
              </>
            )}
          </article>
        ))}
      </Animated>
      {!project.memories.length && (
        <p className="muted">
          Chats save decisions and dimensions here as they finish.
        </p>
      )}
    </section>
  );
}
