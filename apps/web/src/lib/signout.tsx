import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog } from "@windveal/ui";
import { api } from "./api";

/**
 * Sign out, after a confirmation. Returns a function that opens the confirmation and the dialog to render.
 * `everywhere` signs out every device.
 */
export function useSignOut({ everywhere = false, title, message, confirmLabel }: {
  everywhere?: boolean; title?: string; message?: string; confirmLabel?: string;
} = {}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const signOut = async () => {
    setBusy(true);
    try {
      await api.post(everywhere ? "/api/auth/logout-all" : "/api/auth/logout");
    } finally {
      qc.clear();
      setBusy(false);
      setOpen(false);
      navigate("/sign-in");
    }
  };
  const dialog = (
    <ConfirmDialog open={open} onClose={() => setOpen(false)} onConfirm={signOut} loading={busy} danger={everywhere}
      title={title ?? (everywhere ? "Sign out everywhere?" : "Sign out?")} confirmLabel={confirmLabel ?? (everywhere ? "Sign out everywhere" : "Sign out")}>
      <p className="muted" style={{ margin: 0 }}>
        {message ?? (everywhere ? "You'll be signed out on every device, including this one." : "You'll need your email and password to sign in again.")}
      </p>
    </ConfirmDialog>
  );
  return { ask: () => setOpen(true), dialog };
}
