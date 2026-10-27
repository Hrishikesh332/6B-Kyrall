import { useState } from "react";
import {
  ArrowRight,
  ExternalLink,
  FileArchive,
  Maximize,
  Minus,
  Plus,
} from "lucide-react";
import { renderText } from "../format.js";
import { size } from "./lib.js";
import { csvPreview, extensionOf } from "./filePresentation.js";
import { FileIcon } from "./FileLibrary.jsx";

export function DocumentContent({ file, text, truncated }) {
  const [source, setSource] = useState(false);
  const ext = extensionOf(file),
    formatted = ["md", "csv"].includes(ext);
  const table = ext === "csv" ? csvPreview(text) : null;
  return (
    <div className="document-content">
      <div className="document-toolbar">
        <span>
          {ext === "md"
            ? "Document"
            : ext === "csv"
              ? "Table preview"
              : ext === "json"
                ? "Structured data"
                : "Text document"}
        </span>
        {formatted && (
          <div className="document-modes">
            <button aria-pressed={!source} onClick={() => setSource(false)}>
              Preview
            </button>
            <button aria-pressed={source} onClick={() => setSource(true)}>
              Source
            </button>
          </div>
        )}
      </div>
      {truncated && (
        <p className="preview-limit">
          Showing the first 250,000 characters. Download for the complete file.
        </p>
      )}
      {ext === "md" && !source ? (
        <article
          className="document-paper"
          dangerouslySetInnerHTML={{ __html: renderText(text) }}
        />
      ) : table && !source ? (
        <div className="table-preview">
          <table>
            <thead>
              <tr>
                {(table.rows[0] || []).map((cell, i) => (
                  <th key={i} scope="col">
                    {cell || `Column ${i + 1}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.slice(1).map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Preview limited to 200 rows and 50 columns.
            {table.truncated ? " Download to see all rows." : ""}
          </p>
        </div>
      ) : (
        <pre className="source-preview">
          <code>{text}</code>
        </pre>
      )}
    </div>
  );
}
export function ImageContent({ image, name }) {
  const [zoom, setZoom] = useState(100),
    [failed, setFailed] = useState(false);
  return (
    <div className="image-content">
      <div className="image-toolbar">
        <span>Image preview</span>
        <div>
          <button
            className="icon-button"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={zoom <= 50}
            onClick={() => setZoom((n) => Math.max(50, n - 25))}
          >
            <Minus size={15} />
          </button>
          <output aria-label="Image zoom">{zoom}%</output>
          <button
            className="icon-button"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={zoom >= 300}
            onClick={() => setZoom((n) => Math.min(300, n + 25))}
          >
            <Plus size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="Fit image"
            title="Fit image"
            onClick={() => setZoom(100)}
          >
            <Maximize size={15} />
          </button>
        </div>
      </div>
      {failed ? (
        <p className="preview-limit" role="alert">
          This image couldn’t be displayed. Download the original file to open
          it.
        </p>
      ) : (
        <div className="image-stage">
          <img
            src={image}
            alt={`Preview of ${name}`}
            style={{ width: `${zoom}%` }}
            onError={() => setFailed(true)}
          />
        </div>
      )}
    </div>
  );
}
export function PackageContent({ file, taskId, onChange }) {
  const manifest = file.metadata?.manifest || [];
  return (
    <div className="package-content">
      <div className="package-intro">
        <span>
          <FileArchive size={30} strokeWidth={1.3} />
        </span>
        <h3>Everything in one place.</h3>
        <p>
          {manifest.length
            ? `${manifest.length} files in this delivery package. Preview any file below, or download the complete archive.`
            : "Download this archive to access its contents."}
        </p>
      </div>
      {manifest.length > 0 && (
        <div className="package-files">
          {manifest.map((entry) => (
            <button
              key={entry.id}
              onClick={() => onChange({ taskId, artifactId: entry.id })}
              aria-label={`Preview ${entry.name}`}
            >
              <FileIcon file={entry} size={17} />
              <span>
                <strong>{entry.name}</strong>
                <small>
                  {size(entry.size)} · v{entry.version}
                </small>
              </span>
              <ArrowRight size={15} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
export function BrowserFileContent({ url, file }) {
  const pdf = extensionOf(file) === "pdf";
  return (
    <div className="package-content browser-file-content">
      <div className="package-intro">
        <span>
          <FileIcon file={file} size={30} strokeWidth={1.3} />
        </span>
        <h3>{pdf ? "Your document, full size." : "Ready to play."}</h3>
        <p>
          {pdf
            ? "Open this PDF in a new tab with your browser’s document viewer."
            : "Open this file in a new tab with your browser’s media player. If the format isn’t supported, download it to use your preferred app."}
        </p>
      </div>
      <a
        className="secondary"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
      >
        <ExternalLink size={15} /> {pdf ? "Open PDF" : "Open media"}
      </a>
    </div>
  );
}
