import { useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Box,
  CirclePlay,
  Clock3,
  File,
  Folder,
  Pause,
  Play,
  Plus,
  Search,
  ShieldCheck,
  CloudDownload,
} from "lucide-react";
import { api, statusLabel } from "./lib.js";
import { useResource } from "./hooks.js";
import FileLibrary from "./FileLibrary.jsx";
import IntegrationsPage from "./IntegrationsPage.jsx";
import RulesPage from "./RulesPage.jsx";
import { fileKind } from "./filePresentation.js";
import {
  Animated,
  Empty,
  ErrorNotice,
  Loading,
  PageHeading,
  TaskRows,
} from "./ui.jsx";

function ResourceState({ resource }) {
  if (resource.loading) return <Loading />;
  if (resource.error)
    return <ErrorNotice error={resource.error} retry={resource.reload} />;
  return null;
}
export function TaskListPage({ openTask, notify, changed, revision }) {
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [archived, setArchived] = useState(false),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0);
  const resource = useResource(
    `/tasks?q=${encodeURIComponent(search)}&status=${status}&archived=${archived}&limit=50&offset=${offset}`,
    revision,
  );
  const [busy, setBusy] = useState(false);
  const archive = async (id) => {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/tasks/${id}`, {
        method: "PATCH",
        body: { archived: !archived },
      });
      await changed();
      notify(
        archived
          ? "Project restored."
          : "Project archived. Find it in the Archived tab.",
      );
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <PageHeading
        title="Projects"
        description="Your ideas, iterations, and finished designs."
        action={
          <a className="primary" href="#new">
            <Plus size={17} />
            New project
          </a>
        }
      />
      <div className="tabs" aria-label="Project collections">
        <button
          className={!archived ? "active" : ""}
          aria-pressed={!archived}
          onClick={() => {
            setArchived(false);
            setOffset(0);
          }}
        >
          All projects
        </button>
        <button
          className={archived ? "active" : ""}
          aria-pressed={archived}
          onClick={() => {
            setArchived(true);
            setOffset(0);
          }}
        >
          Archived
        </button>
      </div>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(query.trim());
          setOffset(0);
        }}
      >
        <div className="search-field">
          <Search size={17} />
          <input
            aria-label="Search projects"
            placeholder="Search projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All statuses</option>
          {[
            "queued",
            "running",
            "awaiting_input",
            "completed",
            "failed",
            "cancelled",
            "interrupted",
          ].map((s) => (
            <option value={s} key={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
        <button className="secondary">Search</button>
      </form>
      <ResourceState resource={resource} />
      {resource.data && (
        <>
          <div className="results-label">
            {resource.data.total}{" "}
            {resource.data.total === 1 ? "project" : "projects"}
          </div>
          <div aria-busy={busy}>
            {resource.data.items.length ? (
              <TaskRows
                tasks={resource.data.items}
                onOpen={openTask}
                onArchive={archived ? undefined : archive}
                onRestore={archived ? archive : undefined}
              />
            ) : (
              <Empty
                title={
                  search || status
                    ? "No matching projects"
                    : archived
                      ? "No archived projects"
                      : "Your next idea starts here"
                }
              >
                {search || status
                  ? "Try another search or status."
                  : "Start a project to create something new."}
              </Empty>
            )}
          </div>
          {resource.data.total > 50 && (
            <div className="pagination">
              <button
                className="secondary"
                disabled={!offset}
                onClick={() => setOffset((n) => Math.max(0, n - 50))}
              >
                Previous
              </button>
              <span>
                {offset + 1}–{Math.min(offset + 50, resource.data.total)} of{" "}
                {resource.data.total}
              </span>
              <button
                className="secondary"
                disabled={offset + 50 >= resource.data.total}
                onClick={() => setOffset((n) => n + 50)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
export function FilesPage({ openArtifact, revision, notify, setModal }) {
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState("all");
  const resource = useResource("/files", revision);
  const files = (resource.data || []).filter(
    (file) =>
      (category === "all" ||
        (category === "onshape"
          ? file.metadata?.source === "onshape"
          : fileKind(file) === category)) &&
      `${file.name} ${file.task_title || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className="page files-page">
      <PageHeading
        title="Assets"
        description="A visual library of everything you’re creating."
        action={
          <button
            className="secondary"
            onClick={() => setModal({ kind: "onshape", view: "browse" })}
          >
            <CloudDownload size={15} /> Import from Onshape
          </button>
        }
      />
      <div className="tabs" aria-label="File categories">
        {[
          ["all", "All files"],
          ["models", "Models"],
          ["images", "Images"],
          ["documents", "Documents & data"],
          ["packages", "Packages"],
          ...(resource.data?.some((file) => file.metadata?.source === "onshape")
            ? [["onshape", "From Onshape"]]
            : []),
          ...(resource.data?.some((file) => fileKind(file) === "media")
            ? [["media", "Media"]]
            : []),
        ].map(([id, label]) => (
          <button
            key={id}
            className={category === id ? "active" : ""}
            aria-pressed={category === id}
            onClick={() => setCategory(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <>
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(query.trim());
          }}
        >
          <div className="search-field">
            <Search size={16} />
            <input
              aria-label="Search files"
              placeholder="Search files or project titles…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button className="secondary">Search</button>
        </form>
        <ResourceState resource={resource} />
        {resource.data &&
          (files.length ? (
            <FileLibrary
              files={files}
              allFiles={resource.data}
              onOpen={openArtifact}
              notify={notify}
            />
          ) : (
            <Empty
              icon={File}
              title={
                search || category !== "all"
                  ? "No matching files"
                  : "No files yet"
              }
            >
              {search || category !== "all"
                ? "Try a different search or file category."
                : "Files from your projects will appear here, ready to preview and download."}
            </Empty>
          ))}
      </>
    </div>
  );
}
export function ProjectsPage({ projects, setModal, notify, newTask }) {
  const [query, setQuery] = useState("");
  const visibleProjects = projects.filter((project) =>
    `${project.name} ${project.brief}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const edit = async (id) => {
    try {
      setModal({ kind: "project", project: await api(`/projects/${id}`) });
    } catch (error) {
      notify(error.message);
    }
  };
  return (
    <div className="page">
      <PageHeading
        title="Projects"
        description="A shared home for related tasks, briefs, and references."
        action={
          <button
            className="primary"
            onClick={() => setModal({ kind: "project" })}
          >
            <Plus size={17} />
            New project
          </button>
        }
      />
      {projects.length > 0 && (
        <div className="filters">
          <div className="search-field">
            <Search size={16} />
            <input
              aria-label="Search projects"
              placeholder="Search projects…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <span className="toolbar-note">
            {visibleProjects.length}{" "}
            {visibleProjects.length === 1 ? "project" : "projects"}
          </span>
        </div>
      )}
      {visibleProjects.length ? (
        <Animated className="project-grid">
          {visibleProjects.map((p) => (
            <article className="project-card" key={p.id}>
              <div className="project-card-top">
                <span className="project-icon">
                  <Folder size={21} strokeWidth={1.6} />
                </span>
                <span className="project-label">Project</span>
              </div>
              <h2>
                <button onClick={() => edit(p.id)}>{p.name}</button>
              </h2>
              <p>
                {p.brief.slice(0, 180) ||
                  "Add a brief to guide your next design."}
              </p>
              <small>
                <ShieldCheck size={13} />
                {p.memory_scope === "project"
                  ? "Project-only memory"
                  : "Workspace memory"}
              </small>
              <footer>
                <button className="secondary" onClick={() => edit(p.id)}>
                  Edit project
                </button>
                <button className="text-button" onClick={() => newTask(p.id)}>
                  Start project
                  <ArrowRight size={15} />
                </button>
              </footer>
            </article>
          ))}
        </Animated>
      ) : (
        <Empty
          icon={Folder}
          title={query ? "No matching projects" : "Keep your work together"}
          action={
            !query && (
              <button
                className="primary"
                onClick={() => setModal({ kind: "project" })}
              >
                <Plus size={16} />
                Create a project
              </button>
            )
          }
        >
          {query
            ? "Try another project name or brief."
            : "Create a project to give related tasks a shared brief and reference files."}
        </Empty>
      )}
    </div>
  );
}
export function CollectionPage({
  page,
  cap,
  setModal,
  notify,
  changed,
  revision,
  openTask,
}) {
  if (page === "integrations")
    return <IntegrationsPage cap={cap} setModal={setModal} />;
  if (page === "rules") return <RulesPage notify={notify} />;
  return (
    <RemoteCollection
      key={page}
      {...{ page, setModal, notify, changed, revision, openTask }}
    />
  );
}
const every = (minutes) =>
  minutes % 1440 === 0
    ? minutes === 1440
      ? "day"
      : minutes === 10080
        ? "week"
        : `${minutes / 1440} days`
    : minutes % 60 === 0
      ? minutes === 60
        ? "hour"
        : `${minutes / 60} hours`
      : `${minutes} minutes`;
function RemoteCollection({
  page,
  setModal,
  notify,
  changed,
  revision,
  openTask,
}) {
  const resource = useResource(
    page === "schedules" ? "/schedules" : "/memories",
    revision,
  );
  const [busy, setBusy] = useState(null);
  const schedules = page === "schedules";
  const toggle = async (row) => {
    if (busy) return;
    setBusy(row.id);
    try {
      await api(`/schedules/${row.id}`, {
        method: "PATCH",
        body: { enabled: !row.enabled },
      });
      await changed();
      notify(row.enabled ? "Job paused." : "Job enabled.");
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(null);
    }
  };
  // One run now, in its own chat; the job's schedule is left as it is.
  const runNow = async (row) => {
    if (busy) return;
    setBusy(row.id);
    try {
      const task = await api(`/schedules/${row.id}/run`, { method: "POST" });
      await changed();
      notify(`Started “${row.name}”.`);
      openTask(task.id);
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="page">
      <PageHeading
        title={schedules ? "Jobs" : "Workspace memory"}
        description={
          schedules
            ? "Recurring work that runs while 6B is on."
            : "Useful context from completed tasks, ready for your next idea."
        }
        action={
          schedules && (
            <button
              className="primary"
              onClick={() => setModal({ kind: "schedule" })}
            >
              <Plus size={17} />
              New job
            </button>
          )
        }
      />
      <ResourceState resource={resource} />
      {resource.data &&
        (resource.data.length ? (
          <Animated className="collection-list">
            {resource.data.map((row) => (
              <article className="collection-card" key={row.id}>
                {schedules ? (
                  <>
                    <header>
                      <h2>
                        <Clock3 size={18} />
                        {row.name}
                      </h2>
                      <span
                        className={`badge ${row.enabled ? "available" : ""}`}
                      >
                        {row.enabled ? "Enabled" : "Paused"}
                      </span>
                    </header>
                    <p>{row.prompt}</p>
                    <footer>
                      <small>
                        Every {every(row.interval_minutes)}
                        {!!row.enabled &&
                          ` · Next: ${new Date(row.next_run_at * 1000).toLocaleString()}`}
                      </small>
                      <span className="job-actions">
                        <button
                          className="secondary"
                          disabled={!!busy}
                          onClick={() => runNow(row)}
                        >
                          <CirclePlay size={14} />
                          Run now
                        </button>
                        <button
                          className="secondary"
                          disabled={!!busy}
                          onClick={() => toggle(row)}
                        >
                          {row.enabled ? (
                            <Pause size={14} />
                          ) : (
                            <Play size={14} />
                          )}
                          {row.enabled ? "Pause" : "Enable"}
                        </button>
                      </span>
                    </footer>
                    {row.last_task_id && (
                      <button
                        className="text-button"
                        onClick={() => openTask(row.last_task_id)}
                      >
                        View latest result
                        {row.last_task_status && (
                          <span
                            className={`job-run-status ${row.last_task_status}`}
                          >
                            {statusLabel(row.last_task_status)}
                          </span>
                        )}
                        <ArrowRight size={14} />
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <span className="card-icon">
                      <BookOpen size={19} />
                    </span>
                    <p>{row.content}</p>
                    <footer>
                      <button
                        className="text-button"
                        onClick={() => openTask(row.task_id)}
                      >
                        {row.title}
                        <ArrowRight size={14} />
                      </button>
                      <button
                        className="secondary"
                        onClick={() => setModal({ kind: "forget", id: row.id })}
                      >
                        Forget
                      </button>
                    </footer>
                  </>
                )}
              </article>
            ))}
          </Animated>
        ) : (
          <Empty
            icon={schedules ? Clock3 : BookOpen}
            title={
              schedules
                ? "Your time, well spent"
                : "A little context goes a long way"
            }
          >
            {schedules
              ? "Create a job for work you want to repeat."
              : "Completed projects can save summaries here."}
          </Empty>
        ))}
      {schedules && (
        <p className="page-footnote">
          Live model runs use your configured provider’s quota.
        </p>
      )}
    </div>
  );
}
