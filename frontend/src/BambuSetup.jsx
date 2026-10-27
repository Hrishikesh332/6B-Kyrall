import { useEffect, useState } from "react";
import { Check, Printer } from "lucide-react";
import { api } from "./lib.js";
import { ConfirmButton, Dialog, ErrorNotice, Loading } from "./ui.jsx";

// Printer, process and filament used when 6B slices with Bambu Studio.
export default function BambuSetup({ onClose, notify }) {
  const [status, setStatus] = useState(null),
    [options, setOptions] = useState(null),
    // The printer the listed profiles belong to.
    [profilesFor, setProfilesFor] = useState(null),
    [choice, setChoice] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/integrations/bambu")
      .then((s) => {
        setStatus(s);
        setChoice(s.settings);
      })
      .catch(setError);
  }, []);
  useEffect(() => {
    if (!choice?.machine) return;
    // Save waits for this printer's profiles, and a slower answer for the previous
    // printer is dropped, so profiles never pair with the wrong machine.
    const controller = new AbortController();
    api(
      `/integrations/bambu/profiles?machine=${encodeURIComponent(choice.machine)}`,
      { signal: controller.signal },
    )
      .then((o) => {
        setOptions(o);
        setProfilesFor(choice.machine);
        // Keep compatible picks; otherwise fall back to the first compatible profile.
        setChoice((c) => ({
          ...c,
          process: o.processes.includes(c.process)
            ? c.process
            : o.processes.find((p) => p.startsWith("0.20mm Standard")) ||
              o.processes[0],
          filament: o.filaments.includes(c.filament)
            ? c.filament
            : o.filaments.find((f) => f.startsWith("Bambu PLA Basic")) ||
              o.filaments[0],
        }));
      })
      .catch((err) => !controller.signal.aborted && setError(err));
    return () => controller.abort();
  }, [choice?.machine]);
  const save = async () => {
    setBusy(true);
    try {
      setStatus(
        await api("/integrations/bambu", {
          method: "PUT",
          body: { ...choice, enabled: true },
        }),
      );
      notify?.(
        status.connected
          ? "Bambu Studio profiles saved."
          : "Bambu Studio connected.",
      );
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      setStatus(await api("/integrations/bambu", { method: "DELETE" }));
      notify?.("Bambu Studio disconnected. 6B will not slice with it.");
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Bambu Studio" onClose={onClose}>
      <div className="onshape-setup bambu-setup">
        {error && <ErrorNotice error={error} />}
        {!status && !error && <Loading>Looking for Bambu Studio…</Loading>}
        {status && (
          <>
            <div className="connection-summary">
              <span className="connection-icon">
                <Printer size={24} strokeWidth={1.5} />
              </span>
              <div>
                <strong>Bambu Studio</strong>
                <span>
                  {status.installed
                    ? `Version ${status.version} · ${status.path}`
                    : "Not found on this computer"}
                </span>
              </div>
              <span
                className={`connection-status${status.connected ? " is-connected" : ""}`}
              >
                {status.connected ? (
                  <>
                    <Check size={11} /> Connected
                  </>
                ) : status.installed ? (
                  "Not connected"
                ) : (
                  "Not installed"
                )}
              </span>
            </div>
            {status.installed ? (
              <>
                <p>
                  {status.connected
                    ? "6B slices builds in Bambu Studio on this computer and reports print time, filament and Bambu's own printability warnings. The agent can slice before delivering parts."
                    : "Off until you connect it. Once connected, 6B and its agent can slice builds in Bambu Studio for print time, filament and Bambu's own warnings. Without it, 6B uses its built-in printability check."}
                </p>
                {options && choice ? (
                  <div className="bambu-fields">
                    {[
                      ["machine", "Printer", options.machines],
                      ["process", "Print profile", options.processes],
                      ["filament", "Filament", options.filaments],
                    ].map(([key, label, list]) => (
                      <label key={key}>
                        {label}
                        <select
                          aria-label={label}
                          value={choice[key] || ""}
                          onChange={(e) =>
                            setChoice((c) => ({ ...c, [key]: e.target.value }))
                          }
                        >
                          {list.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                ) : (
                  <Loading>Reading printer profiles…</Loading>
                )}
                {status.bed_mm && (
                  <small className="bambu-bed">
                    Current bed: {status.bed_mm.slice(0, 2).join(" × ")} mm,{" "}
                    {status.bed_mm[2]} mm tall.
                  </small>
                )}
                <div className="form-actions">
                  {status.connected && (
                    <ConfirmButton
                      confirm="Disconnect?"
                      disabled={busy}
                      onConfirm={disconnect}
                    >
                      Disconnect
                    </ConfirmButton>
                  )}
                  <button className="secondary" onClick={onClose}>
                    Cancel
                  </button>
                  <button
                    className="primary"
                    disabled={
                      busy || !options || profilesFor !== choice?.machine
                    }
                    onClick={save}
                  >
                    {busy
                      ? "Saving…"
                      : status.connected
                        ? "Save profiles"
                        : "Connect"}
                  </button>
                </div>
              </>
            ) : (
              <p>
                Install Bambu Studio from bambulab.com, then reopen this dialog.
                Set 6B_BAMBU_STUDIO if it lives outside Applications.
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
