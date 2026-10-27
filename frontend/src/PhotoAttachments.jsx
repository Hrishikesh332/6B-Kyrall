import { useEffect, useState } from "react";
import { X } from "lucide-react";

export const photoTypes = ["image/png", "image/jpeg", "image/webp"];
export const maxPhotos = 12;
const roles = [
  ["object", "Object"],
  ["gripper", "Gripper"],
];

function Thumbnail({ file }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return src ? <img src={src} alt={file.name} /> : null;
}

// Photos staged in the chat composer. Each one says whether it shows the
// object to model or grip, or gripper hardware, so the agent reads it right.
export default function PhotoAttachments({ photos, onChange }) {
  if (!photos.length) return null;
  const update = (id, patch) =>
    onChange(photos.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  return (
    <div className="photo-attachments" aria-label="Attached photos">
      {photos.map((photo, index) => (
        <article className="photo-chip" key={photo.id}>
          <Thumbnail file={photo.file} />
          <button
            type="button"
            className="photo-remove"
            aria-label={`Remove ${photo.file.name}`}
            onClick={() => onChange(photos.filter((p) => p.id !== photo.id))}
          >
            <X size={12} />
          </button>
          <div
            className="segmented"
            role="group"
            aria-label={`Photo ${index + 1} shows`}
          >
            {roles.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={photo.role === value}
                onClick={() => update(photo.id, { role: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}
