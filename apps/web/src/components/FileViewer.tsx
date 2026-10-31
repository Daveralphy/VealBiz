import { Download } from "lucide-react";
import { Modal } from "@windveal/ui";
import { formatBytes } from "@windveal/shared";

export type ViewableFile = { id: string; name: string; mime: string; size?: number };

/** Opens a stored file in place: images and PDFs are shown, anything else can be downloaded. */
export function FileViewer({ file, url, onClose }: { file: ViewableFile | null; url: (id: string, download?: boolean) => string; onClose: () => void }) {
  if (!file) return null;
  const isImage = file.mime.startsWith("image/");
  const isPdf = file.mime === "application/pdf";
  return (
    <Modal open onClose={onClose} title={file.name} subtitle={file.size ? formatBytes(file.size) : undefined} size="lg"
      footer={<a className="btn btn-secondary" href={url(file.id, true)} download={file.name}><Download size={15} />Download</a>}>
      {isImage ? (
        <div className="fv-image"><img src={url(file.id)} alt={file.name} /></div>
      ) : isPdf ? (
        <iframe className="fv-pdf" src={url(file.id)} title={file.name} />
      ) : (
        <p className="muted">This file can't be previewed here. Download it to open it.</p>
      )}
    </Modal>
  );
}
