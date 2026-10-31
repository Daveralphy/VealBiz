import React from "react";
import ReactDOM from "react-dom/client";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider, showToast } from "@windveal/ui";
import "@windveal/ui/styles.css";
import "./app.css";
import { App } from "./App";
import { ApiError } from "./lib/api";
import { applyTheme } from "./lib/theme";

try {
  const t = localStorage.getItem("wv-theme");
  if (t === "dark" || t === "light") applyTheme(t);
} catch { /* ignore */ }

const queryClient = new QueryClient({
  // Every failed change shows its error as a toast (forms and screens may add their own handling).
  mutationCache: new MutationCache({
    onError: (err) => showToast(err instanceof ApiError ? err.message : "Something went wrong. Please try again.", "error"),
  }),
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      // Screens you've already opened come back instantly from memory, then refresh quietly in the background.
      staleTime: 30_000,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
