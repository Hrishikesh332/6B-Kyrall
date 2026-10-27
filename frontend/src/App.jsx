import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAvatar } from "@dicebear/core";
import { avataaars } from "@dicebear/collection";
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Box,
  ChevronRight,
  ChevronDown,
  Component,
  Clock3,
  Cpu,
  Files,
  Plus,
  Plug,
  ShieldCheck,
  ScrollText,
  ExternalLink,
  Menu,
  Settings2,
  ListTodo,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  X,
} from "lucide-react";
import { api, date, modeLabel, samples } from "./lib.js";
import OnshapeSetup, { OnshapeExport } from "./OnshapeSetup.jsx";
import BambuSetup from "./BambuSetup.jsx";
import ModelConnection from "./ModelConnection.jsx";
import ProviderLogo from "./ProviderLogo.jsx";
import {
  Animated,
  Composer,
  Dialog,
  ErrorNotice,
  FormDialog,
  IconButton,
  Loading,
  Badge,
} from "./ui.jsx";
import {
  CollectionPage,
  FilesPage,
  ProjectsPage,
  TaskListPage,
} from "./pages.jsx";
import TaskPage from "./TaskPage.jsx";
import ArtifactPreview from "./ArtifactPreview.jsx";
import ProjectPage from "./ProjectPage.jsx";
import SignIn, { GoogleMark } from "./SignIn.jsx";
import { authConfig, signInWithGoogle, signOut } from "./auth.js";

const navigation = [
  ["new", "New chat", Plus],
  ["tasks", "Chats", ListTodo],
  ["files", "Assets", Files],
  ["integrations", "Integrations", Cpu],
  ["schedules", "Jobs", Clock3],
  ["memory", "Memory", BookOpen],
  ["rules", "Rules", ScrollText],
];
const currentRoute = () => location.hash.slice(1) || "new";

// A random cartoon DiceBear avatar (Avataaars, free for commercial use), seeded
// once per browser so it stays stable. It is served as a blob: URL because the
// Content-Security-Policy allows blob: images but not data: URIs.
function WorkspaceAvatar() {
  const svg = useMemo(() => {
    let seed = "";
    try {
      seed = localStorage.getItem("6b:avatar-seed") || "";
      if (!seed) {
        seed = crypto.randomUUID();
        localStorage.setItem("6b:avatar-seed", seed);
      }
    } catch {
      seed = "6b";
    }
    return createAvatar(avataaars, {
      seed,
      size: 64,
      backgroundColor: ["b6e3f4", "c0aede", "d1d4f9", "ffd5dc", "ffdfbf"],
      backgroundType: ["solid"],
    }).toString();
  }, []);
  const [uri, setUri] = useState(null);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    setUri(url);
    return () => URL.revokeObjectURL(url);
  }, [svg]);
  return uri ? <img className="profile-avatar" src={uri} alt="" /> : null;
}

// The Google account's photo, or its initial when it has none.
function AccountAvatar({ user }) {
  const [failed, setFailed] = useState(false);
  if (user.picture && !failed)
    return (
      <img
        className="profile-avatar google"
        src={user.picture}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  return (
    <span className="profile-avatar google initial" aria-hidden="true">
      {(user.name || user.email || "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

// Top right: "Sign in with Google" while signed out, the account once signed in.
function TopbarAccount({ auth, notify, boot, openSettings }) {
  const [busy, setBusy] = useState(false);
  if (auth.user)
    return (
      <button
        className="topbar-account signed-in"
        onClick={openSettings}
        aria-label={`Account: ${auth.user.email}`}
        title={auth.user.email}
      >
        <AccountAvatar user={auth.user} />
        <span>{auth.user.name?.split(" ")[0] || auth.user.email}</span>
      </button>
    );
  const signIn = async () => {
    setBusy(true);
    try {
      const user = await signInWithGoogle(auth.firebase);
      if (!user) return;
      await boot();
      notify(
        `Signed in as ${user.email}. Your chats are being saved to your account.`,
      );
    } catch (err) {
      notify(err.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      className="topbar-account google-button"
      onClick={signIn}
      disabled={busy}
      aria-busy={busy || undefined}
    >
      <GoogleMark />
      {busy ? "Signing in…" : "Sign in with Google"}
    </button>
  );
}

const activeStatuses = new Set(["queued", "running", "awaiting_input"]);

// A project's latest chats, with live task updates taking precedence.
function projectChats(project, tasks) {
  const live = tasks.filter((t) => t.project_id === project.id);
  const ids = new Set(tasks.map((t) => t.id));
  return [
    ...live,
    ...(project.recent_chats || []).filter((t) => !ids.has(t.id)),
  ]
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 5);
}

export default function App() {
  const [route, setRoute] = useState(currentRoute);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cap, setCap] = useState(null),
    [tasks, setTasks] = useState([]),
    [projects, setProjects] = useState([]);
  const [error, setError] = useState(null),
    [loading, setLoading] = useState(true),
    [connected, setConnected] = useState(false);
  const [modal, setModal] = useState(null),
    [preview, setPreview] = useState(null),
    [toast, setToast] = useState(null);
  // Google sign-in: { enabled, firebase, user } from the server; null until known.
  const [auth, setAuth] = useState(null);
  const [revision, setRevision] = useState(0),
    [projectId, setProjectId] = useState("");
  const [taskTitle, setTaskTitle] = useState(""),
    [taskProject, setTaskProject] = useState(null);
  const toastTimer = useRef(null);
  const sidebar = useRef(null);
  useEffect(() => {
    if (!menuOpen) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sidebar.current
      ?.querySelector('button[aria-label="Close sidebar"]')
      ?.focus();
    const desktop = window.matchMedia("(min-width: 761px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setMenuOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => {
      document.body.style.overflow = previousOverflow;
      desktop.removeEventListener("change", closeOnDesktop);
      previousFocus?.focus?.();
    };
  }, [menuOpen]);
  // tone: "success" for confirmations, "warning" for refused requests, "error" for failures.
  // Problems stay up longer so they can be read.
  const notify = useCallback((message, tone = "success") => {
    setToast({ message, tone });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(
      () => setToast(null),
      tone === "success" ? 5500 : 9000,
    );
  }, []);
  const refreshSidebar = useCallback(async () => {
    const [t, p] = await Promise.all([
      api("/tasks?limit=15"),
      api("/projects"),
    ]);
    setTasks(t.items);
    setProjects(p);
  }, []);
  const boot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const account = await authConfig();
      setAuth(account);
      if (account.required && !account.user) return;
      const c = await api("/capabilities");
      setCap(c);
      await refreshSidebar();
      setConnected(true);
    } catch (err) {
      setError(err);
      setConnected(false);
    } finally {
      setLoading(false);
    }
  }, [refreshSidebar]);
  useEffect(() => {
    const change = () => {
      setRoute(currentRoute());
      setMenuOpen(false);
      setPreview(null);
    };
    const unlock = () => setModal({ kind: "token" });
    // The session cookie expired or was signed out elsewhere.
    const signedOut = () => {
      setModal(null);
      setAuth((account) => account && { ...account, user: null });
    };
    window.addEventListener("hashchange", change);
    window.addEventListener("6b:unlock", unlock);
    window.addEventListener("6b:sign-in", signedOut);
    void boot();
    return () => {
      window.removeEventListener("hashchange", change);
      window.removeEventListener("6b:unlock", unlock);
      window.removeEventListener("6b:sign-in", signedOut);
      clearTimeout(toastTimer.current);
    };
  }, [boot]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);
  const navigate = useCallback((next) => {
    setPreview(null);
    setRoute(next);
    setMenuOpen(false);
    location.hash = next;
  }, []);
  const newTask = useCallback(
    (project = "") => {
      setProjectId(project);
      navigate("new");
      requestAnimationFrame(() => {
        const composer = document.querySelector(
          'textarea[aria-label="Describe your project"]',
        );
        composer?.focus();
        composer?.scrollIntoView({ block: "center" });
      });
    },
    [navigate],
  );
  const openTask = useCallback((id) => navigate(`task=${id}`), [navigate]);
  const openProject = useCallback(
    (id) => navigate(`project=${id}`),
    [navigate],
  );
  const openArtifact = useCallback(
    (taskId, artifactId) => setPreview({ taskId, artifactId }),
    [],
  );
  const closeModal = useCallback(() => setModal(null), []);
  const refreshCap = useCallback(
    async () => setCap(await api("/capabilities")),
    [],
  );
  // After an Onshape import, land on its task with the 3D studio open.
  const showImport = useCallback(
    async (result) => {
      setModal(null);
      const target = `task=${result.task_id}`;
      const open = () =>
        setPreview({
          taskId: result.task_id,
          artifactId: result.preview_artifact_id,
        });
      if (location.hash.slice(1) === target) open();
      else {
        // The route listener clears previews on navigation, so open after it.
        window.addEventListener("hashchange", open, { once: true });
        navigate(target);
      }
      setRevision((n) => n + 1);
      await refreshSidebar();
    },
    [navigate, refreshSidebar],
  );
  const onTaskChange = useCallback((task) => {
    setTaskTitle(task.title);
    setTaskProject(task.project_id || null);
    setTasks((list) =>
      [{ ...task }, ...list.filter((x) => x.id !== task.id)]
        .filter((x) => !x.archived)
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, 15),
    );
  }, []);
  const page = route.startsWith("task=")
    ? "task"
    : route.startsWith("project=")
      ? "project"
      : route;
  const routeProject = page === "project" ? route.slice(8) : taskProject;
  const crumbProject =
    page === "project" || page === "task"
      ? projects.find((p) => p.id === routeProject)
      : null;
  const title =
    page === "task"
      ? taskTitle
      : page === "project"
        ? crumbProject?.name || "Project"
        : page === "projects"
          ? "Projects"
          : navigation.find((x) => x[0] === page)?.[1] || "Overview";
  useEffect(() => {
    document.title = `${title} — 6B`;
  }, [title]);
  useEffect(() => {
    const keydown = (e) => {
      // An open dialog handles its own Escape; leave the preview behind it open.
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
        setPreview(null);
        setMenuOpen(false);
      }
      if (
        e.key === "n" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) &&
        !e.target.isContentEditable &&
        !document.querySelector("dialog[open]") &&
        !modal
      )
        newTask();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [modal, newTask]);
  const createTask = async (body) => {
    let task;
    try {
      task = await api("/tasks", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body,
      });
    } catch (err) {
      // Not a CAD request: nothing was started, so say why and leave the draft as typed.
      if (err.code !== "off_topic") throw err;
      notify(err.message, "warning");
      return false;
    }
    setTasks((list) =>
      [task, ...list.filter((x) => x.id !== task.id)].slice(0, 15),
    );
    openTask(task.id);
  };
  const changed = async () => {
    setRevision((n) => n + 1);
    await refreshSidebar();
  };
  const common = {
    notify,
    openTask,
    openArtifact,
    setModal,
    changed,
    revision,
  };
  if (auth?.required && !auth.user)
    return <SignIn config={auth.firebase} onSignedIn={boot} />;
  return (
    <>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      {menuOpen && (
        <button
          className="navigation-scrim"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside
        ref={sidebar}
        id="workspace-navigation"
        className={`app-sidebar ${menuOpen ? "is-open" : ""}`}
        onKeyDown={(event) => {
          if (!menuOpen || event.key !== "Tab") return;
          const controls = [
            ...sidebar.current.querySelectorAll("a[href], button"),
          ];
          const first = controls[0],
            last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="sidebar-brand">
          <a
            className="brand"
            href="#new"
            aria-label="6B home"
            onClick={() => setMenuOpen(false)}
          >
            <span className="brand-symbol">
              <Component size={19} strokeWidth={1.6} />
            </span>
            <span>6B</span>
          </a>
          <button
            className="icon-button mobile-menu"
            aria-label="Close sidebar"
            onClick={() => setMenuOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <nav className="sidebar-navigation" aria-label="Workspace navigation">
          {navigation.map(([id, label, Icon]) => (
            <a
              key={id}
              href={`#${id}`}
              onClick={() => setMenuOpen(false)}
              className={`${(id === "tasks" ? ["tasks", "task"].includes(page) : page === id) ? "active" : ""} ${id === "new" ? "new-task-link" : ""}`}
              aria-current={
                (
                  id === "tasks"
                    ? ["tasks", "task"].includes(page)
                    : page === id
                )
                  ? "page"
                  : undefined
              }
            >
              <Icon size={17} strokeWidth={1.7} />
              <span>{label}</span>
              {id === "new" && <kbd aria-hidden="true">N</kbd>}
            </a>
          ))}
        </nav>
        <details className="sidebar-recents sidebar-projects" open>
          <summary>
            Projects
            <ChevronDown size={13} />
          </summary>
          <div className="sidebar-recent-links">
            <button
              className="sidebar-new-project"
              onClick={() => {
                setMenuOpen(false);
                setModal({ kind: "project" });
              }}
            >
              <FolderPlus size={14} />
              <span>New project</span>
            </button>
            {projects.slice(0, 8).map((p) => {
              const chats = projectChats(p, tasks);
              return (
                <div className="sidebar-project" key={p.id}>
                  <a
                    href={`#project=${p.id}`}
                    onClick={() => setMenuOpen(false)}
                    className={`sidebar-project-folder ${page === "project" && routeProject === p.id ? "active" : ""}`}
                    title={p.name}
                  >
                    {chats.length ? (
                      <FolderOpen size={16} strokeWidth={1.6} />
                    ) : (
                      <Folder size={16} strokeWidth={1.6} />
                    )}
                    <span>{p.name}</span>
                  </a>
                  {chats.map((task) => (
                    <a
                      key={task.id}
                      href={`#task=${task.id}`}
                      onClick={() => setMenuOpen(false)}
                      className={`sidebar-project-chat ${route === `task=${task.id}` ? "active" : ""}`}
                      title={task.title}
                    >
                      <span>{task.title}</span>
                      {activeStatuses.has(task.status) && (
                        <i className="sidebar-chat-dot" aria-label="Running" />
                      )}
                    </a>
                  ))}
                </div>
              );
            })}
            {projects.length > 8 && (
              <a href="#projects" onClick={() => setMenuOpen(false)}>
                <Folder size={14} />
                <span>All projects</span>
              </a>
            )}
          </div>
        </details>
        <details className="sidebar-recents">
          <summary>
            Recent work
            <ChevronDown size={13} />
          </summary>
          <div className="sidebar-recent-links">
            {tasks
              .filter((task) => !task.project_id)
              .slice(0, 6)
              .map((task) => (
                <a
                  key={task.id}
                  href={`#task=${task.id}`}
                  onClick={() => setMenuOpen(false)}
                  className={route === `task=${task.id}` ? "active" : ""}
                  title={task.title}
                >
                  <MessageSquare size={14} />
                  <span>{task.title}</span>
                </a>
              ))}
            {!tasks.some((task) => !task.project_id) && (
              <p>Your designs will appear here.</p>
            )}
          </div>
        </details>
        <div className="sidebar-footer">
          <a href="/docs" target="_blank" rel="noreferrer">
            <BookOpen size={16} />
            Documentation
            <ExternalLink size={13} />
          </a>
          <button
            className="workspace-profile"
            onClick={() => {
              setMenuOpen(false);
              setModal({ kind: "settings" });
            }}
            aria-label="Workspace settings"
          >
            {auth?.user ? (
              <>
                <AccountAvatar user={auth.user} />
                <span>
                  <strong>{auth.user.name || auth.user.email}</strong>
                  <small>{auth.user.email}</small>
                </span>
              </>
            ) : (
              <>
                <WorkspaceAvatar />
                <span>
                  <strong>Personal workspace</strong>
                  <small>Saved on this computer</small>
                </span>
              </>
            )}
            <Settings2 size={16} />
          </button>
        </div>
      </aside>
      <div className="app-canvas" inert={menuOpen || undefined}>
        <header className="workspace-topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            aria-expanded={menuOpen}
            aria-controls="workspace-navigation"
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={19} />
          </button>
          <div className="workspace-location">
            <span>Personal workspace</span>
            <ChevronRight size={13} />
            {page === "task" && crumbProject && (
              <>
                <a href={`#project=${crumbProject.id}`}>{crumbProject.name}</a>
                <ChevronRight size={13} />
              </>
            )}
            <strong>{title}</strong>
          </div>
          {!connected && (
            <span className="workspace-connection">
              <span className="status-dot offline" />
              Disconnected
            </span>
          )}
          {auth?.enabled && (
            <TopbarAccount
              auth={auth}
              notify={notify}
              boot={boot}
              openSettings={() => setModal({ kind: "settings" })}
            />
          )}
        </header>
        <div className="workspace-shell">
          <main
            id="main-content"
            tabIndex={-1}
            className={preview ? "main-content with-preview" : "main-content"}
          >
            {loading ? (
              <Loading />
            ) : error ? (
              <div className="page">
                <ErrorNotice error={error} retry={boot} />
              </div>
            ) : (
              <div className="page-transition">
                <div key={page === "task" ? route : page}>
                  {page === "new" && (
                    <Home
                      tasks={tasks}
                      projects={projects}
                      cap={cap}
                      refreshCap={refreshCap}
                      projectId={projectId}
                      createTask={createTask}
                      openTask={openTask}
                      setModal={setModal}
                      notify={notify}
                    />
                  )}
                  {page === "tasks" && <TaskListPage {...common} />}
                  {page === "projects" && (
                    <ProjectsPage
                      {...common}
                      projects={projects}
                      openProject={openProject}
                    />
                  )}
                  {page === "project" && (
                    <ProjectPage
                      {...common}
                      id={route.slice(8)}
                      cap={cap}
                      projects={projects}
                      createTask={createTask}
                      onModelChange={refreshCap}
                    />
                  )}
                  {page === "files" && <FilesPage {...common} />}
                  {["integrations", "schedules", "memory", "rules"].includes(
                    page,
                  ) && <CollectionPage {...common} page={page} cap={cap} />}
                  {page === "task" && (
                    <TaskPage
                      {...common}
                      id={route.slice(5)}
                      cap={cap}
                      onTaskChange={onTaskChange}
                      onConnection={setConnected}
                    />
                  )}
                  {!navigation.some((x) => x[0] === page) &&
                    !["task", "project", "projects"].includes(page) && (
                      <div className="page">
                        <h1>Page not found</h1>
                        <button
                          className="primary"
                          onClick={() => navigate("new")}
                        >
                          Back to workspace
                        </button>
                      </div>
                    )}
                </div>
              </div>
            )}
          </main>
        </div>
        {preview && (
          <ArtifactPreview
            {...preview}
            onChange={setPreview}
            onClose={() => setPreview(null)}
            notify={notify}
            sendToOnshape={(file, title) =>
              setModal({
                kind: "onshape-export",
                taskId: file.task_id,
                artifactId: file.id,
                name: file.name,
                title,
              })
            }
          />
        )}
      </div>
      <Animated className="toast-container" aria-live="polite">
        {toast && (
          <div
            className={`toast ${toast.tone}`}
            role={toast.tone === "error" ? "alert" : "status"}
          >
            {toast.tone === "success" ? (
              <ShieldCheck size={17} />
            ) : (
              <AlertCircle size={17} />
            )}
            {toast.message}
            <IconButton
              label="Dismiss notification"
              onClick={() => setToast(null)}
            >
              <X size={15} />
            </IconButton>
          </div>
        )}
      </Animated>
      {modal && (
        <ModalContent
          modal={modal}
          cap={cap}
          user={auth?.user}
          close={closeModal}
          boot={boot}
          changed={changed}
          notify={notify}
          refreshCap={refreshCap}
          showImport={showImport}
          setModal={setModal}
        />
      )}
    </>
  );
}
export function Home({
  tasks,
  projects,
  cap,
  refreshCap,
  projectId,
  createTask,
  openTask,
  setModal,
  notify,
}) {
  const [draft, setDraft] = useState("");
  const clearDraft = useCallback(() => setDraft(""), []);
  const onshapeConnected = cap?.integrations?.some(
    (item) => item.name === "Onshape" && item.status === "connected",
  );
  const focusComposer = () => {
    const input = document.querySelector(
      'textarea[aria-label="Describe your project"]',
    );
    input?.focus();
    input?.scrollIntoView({ block: "center" });
  };
  return (
    <div className="home page">
      <section className="start-workspace" aria-labelledby="start-heading">
        <div className="workspace-kicker">
          <span />
          DESIGN WORKSPACE
        </div>
        <h1 id="start-heading">What will you create?</h1>
        <p>Describe the part, assembly, or change you have in mind.</p>
        <div className="start-grid">
          <div className="design-brief">
            <Composer
              initial
              projects={projects}
              cap={cap}
              onModelChange={refreshCap}
              onConnectModel={() => setModal({ kind: "model" })}
              onSubmit={createTask}
              onRefused={notify}
              projectId={projectId}
              draft={draft}
              onDraftUsed={clearDraft}
            />
            <p className="brief-hint">
              <span>Be specific about dimensions and materials.</span>
              <span>
                Enter to send <span aria-hidden="true">↵</span>
              </span>
            </p>
          </div>
          <div className="design-starters" aria-label="Example projects">
            <h2>Try an idea</h2>
            {samples.map((sample, index) => (
              <button
                key={sample.id}
                onClick={() => {
                  setDraft(sample.prompt);
                  focusComposer();
                }}
                aria-label={sample.title}
              >
                <span className="starter-number">0{index + 1}</span>
                <span className="starter-copy">
                  <strong>
                    {sample.id === "markers"
                      ? "Wall organizer"
                      : "Mounting plate"}
                  </strong>
                  <small>
                    {sample.id === "markers"
                      ? "A printable assembly"
                      : "A parametric part"}
                  </small>
                </span>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        </div>
        <button
          className="home-connection"
          onClick={() =>
            setModal(
              onshapeConnected
                ? { kind: "onshape", view: "browse" }
                : { kind: "onshape" },
            )
          }
        >
          <Plug size={15} />
          <span>Working in Onshape?</span>
          <strong>
            {onshapeConnected ? "Import a design" : "Set up connection"}
          </strong>
          <ArrowRight size={14} />
        </button>
      </section>
      <section className="home-recents" aria-label="Recent projects">
        <div className="section-heading">
          <div>
            <h2>Recent work</h2>
            <p>Continue where you left off.</p>
          </div>
          <a className="text-button" href="#tasks">
            View all
            <ArrowRight size={15} />
          </a>
        </div>
        {tasks.length ? (
          <div className="recent-work-list">
            {tasks.slice(0, 4).map((task) => (
              <button
                key={task.id}
                className="recent-work-row"
                onClick={() => openTask(task.id)}
              >
                <span className="recent-work-icon">
                  <Box size={21} strokeWidth={1.5} />
                </span>
                <span className="recent-work-title">
                  <strong>{task.title}</strong>
                  <small>
                    {task.context_scope === "isolated"
                      ? "Personal project"
                      : `${task.context_scope} context`}
                  </small>
                </span>
                <time>{date(task.updated_at)}</time>
                <Badge status={task.status} />
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        ) : (
          <div className="home-empty">
            <MessageSquare size={18} />
            <span>Your recent designs will appear here.</span>
          </div>
        )}
      </section>
    </div>
  );
}

function ModalContent({
  modal,
  cap,
  user,
  close,
  boot,
  changed,
  notify,
  refreshCap,
  showImport,
  setModal,
}) {
  if (modal.kind === "bambu")
    return <BambuSetup onClose={close} notify={notify} />;
  if (modal.kind === "onshape-export")
    return (
      <OnshapeExport
        {...modal}
        onClose={close}
        onConnect={() => setModal({ kind: "onshape" })}
      />
    );
  if (modal.kind === "onshape")
    return (
      <OnshapeSetup
        onClose={close}
        onChanged={refreshCap}
        onImported={showImport}
        notify={notify}
        view={modal.view}
        taskId={modal.taskId}
      />
    );
  if (modal.kind === "model")
    return (
      <ModelConnection
        onClose={close}
        onChanged={refreshCap}
        notify={notify}
        initialProvider={modal.provider}
        signInError={modal.signInError}
      />
    );
  if (modal.kind === "token")
    return (
      <FormDialog
        title="Unlock your workspace"
        onClose={close}
        submitLabel="Unlock"
        busyLabel="Unlocking…"
        onSubmit={async (data) => {
          sessionStorage.setItem("6b-token", data.token);
          await api("/capabilities");
          await boot();
        }}
      >
        <p className="muted">
          Enter the local API token configured for this workspace.
        </p>
        <label>
          Local API token
          <input
            type="password"
            name="token"
            required
            autoComplete="off"
            autoFocus
          />
        </label>
      </FormDialog>
    );
  if (modal.kind === "settings")
    return (
      <Dialog title="Workspace settings" onClose={close}>
        <div className="settings-content">
          <div className="settings-mode">
            <span className="app-logo">
              <ProviderLogo provider={cap?.provider} size={24} />
            </span>
            <div>
              <strong>{modeLabel(cap)}</strong>
              <p>Model</p>
            </div>
            <button
              className="secondary"
              onClick={() => setModal({ kind: "model" })}
            >
              Change
            </button>
          </div>
          {user ? (
            <div className="settings-mode">
              <AccountAvatar user={user} />
              <div>
                <strong>{user.name || user.email}</strong>
                <p>{user.email}</p>
              </div>
              <button
                className="secondary"
                onClick={async () => {
                  close();
                  await signOut();
                  await boot();
                }}
              >
                Sign out
              </button>
            </div>
          ) : null}
          <p>
            {user
              ? "Your chats are copied to the cloud as each run starts and finishes."
              : "Projects and files stay on this computer."}
          </p>
          <a
            className="text-button"
            href="/docs"
            target="_blank"
            rel="noreferrer"
          >
            API documentation
            <ArrowRight size={14} />
          </a>
        </div>
      </Dialog>
    );
  if (modal.kind === "project")
    return (
      <ProjectDialog
        modal={modal}
        close={close}
        changed={changed}
        notify={notify}
      />
    );
  if (modal.kind === "schedule")
    return (
      <FormDialog
        title="New job"
        onClose={close}
        submitLabel="Create job"
        busyLabel="Creating…"
        onSubmit={async (data) => {
          await api("/schedules", {
            method: "POST",
            body: {
              ...data,
              interval_minutes: Number(data.interval_minutes),
              enabled: false,
            },
          });
          await changed();
          notify("Schedule created and paused.");
        }}
      >
        <label>
          Name
          <input name="name" required maxLength={100} autoFocus />
        </label>
        <label>
          Instructions
          <textarea name="prompt" rows={4} required maxLength={24000} />
        </label>
        <label>
          Repeat every (minutes)
          <input
            name="interval_minutes"
            type="number"
            min="60"
            max="525600"
            defaultValue="1440"
            required
          />
        </label>
        <p className="muted">
          Created paused. Enable it when ready. Schedules run while the local
          server is running.
        </p>
      </FormDialog>
    );
  if (modal.kind === "rename")
    return (
      <FormDialog
        title="Rename chat"
        onClose={close}
        onSubmit={async (data) => {
          await api(`/tasks/${modal.task.id}`, { method: "PATCH", body: data });
          await modal.refresh();
        }}
      >
        <label>
          Chat name
          <input
            name="title"
            defaultValue={modal.task.title}
            required
            maxLength={100}
            autoFocus
          />
        </label>
      </FormDialog>
    );
  if (modal.kind === "trace")
    return (
      <Dialog title="Execution trace" onClose={close}>
        <p className="muted">Recorded tool calls and results.</p>
        <pre className="trace">{JSON.stringify(modal.trace, null, 2)}</pre>
      </Dialog>
    );
  if (modal.kind === "forget")
    return (
      <FormDialog
        title="Forget this memory?"
        onClose={close}
        submitLabel="Forget memory"
        busyLabel="Forgetting…"
        onSubmit={async () => {
          await api(`/memories/${modal.id}`, { method: "DELETE" });
          await changed();
          notify("Memory removed.");
        }}
      >
        <p>
          This removes the saved summary. The original task and its files remain
          available.
        </p>
      </FormDialog>
    );
  return null;
}
function ProjectDialog({ modal, close, changed, notify }) {
  const [project, setProject] = useState(
    modal.project || {
      name: "",
      brief: "",
      memory_scope: "project",
      files: [],
    },
  );
  const [busy, setBusy] = useState(false);
  const fileInput = useRef(null);
  const upload = async (e) => {
    setBusy(true);
    try {
      for (const file of e.target.files) {
        const body = new FormData();
        body.append("file", file);
        await api(`/projects/${project.id}/files`, { method: "POST", body });
      }
      const updated = await api(`/projects/${project.id}`);
      setProject((p) => ({ ...p, files: updated.files }));
      notify("Reference files attached.");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  };
  return (
    <FormDialog
      title={project.id ? "Project context" : "New project"}
      onClose={close}
      submitLabel="Save project"
      onSubmit={async (data) => {
        const saved = await api(
          `/projects${project.id ? `/${project.id}` : ""}`,
          {
            method: project.id ? "PATCH" : "POST",
            body: data,
          },
        );
        await changed();
        notify("Project saved.");
        if (!project.id) location.hash = `project=${saved.id}`;
      }}
    >
      <label>
        Name
        <input
          name="name"
          defaultValue={project.name}
          required
          maxLength={100}
          autoFocus
        />
      </label>
      <label>
        Shared brief
        <textarea
          name="brief"
          defaultValue={project.brief}
          rows={5}
          maxLength={20000}
          placeholder="Requirements, reference dimensions, and decisions…"
        />
      </label>
      <label>
        Memory scope
        <select name="memory_scope" defaultValue={project.memory_scope}>
          <option value="project">Project only</option>
          <option value="workspace">Entire workspace</option>
        </select>
      </label>
      {project.id && (
        <div className="project-references">
          <small>{project.files?.length || 0} reference files</small>
          {project.files?.map((f) => (
            <div key={f.id}>{f.name}</div>
          ))}
          <input
            type="file"
            hidden
            multiple
            ref={fileInput}
            onChange={upload}
          />
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => fileInput.current.click()}
          >
            <Plus size={16} />
            {busy ? "Uploading…" : "Attach reference"}
          </button>
        </div>
      )}
    </FormDialog>
  );
}
