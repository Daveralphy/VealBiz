import { useEffect } from "react";

const env = import.meta.env as Record<string, string | undefined>;
export const APP_URL: string = (import.meta.env.VITE_APP_URL as string | undefined) ?? "http://localhost:5173";
/** The WindVeal app in a browser (the website itself has no sign-in; people get the app from /download). */
export const WEB_APP_URL = APP_URL;
export const DOWNLOAD_PATH = "/download";

export type PlatformKey = "windows" | "mac" | "linux" | "android" | "ios";
/** Where each app is downloaded from (apps/site/.env). A platform without a link shows as "Coming soon". */
export const DOWNLOADS: Record<PlatformKey, string | undefined> = {
  windows: env.VITE_DOWNLOAD_WINDOWS || undefined,
  mac: env.VITE_DOWNLOAD_MAC || undefined,
  linux: env.VITE_DOWNLOAD_LINUX || undefined,
  android: env.VITE_DOWNLOAD_ANDROID || undefined,
  ios: env.VITE_DOWNLOAD_IOS || undefined,
};
/** Settings come from apps/site/.env (see .env.example), not from the code. */
export const CONTACT_EMAIL = env.VITE_CONTACT_EMAIL ?? "hello@windveal.com";
/** The organisation whose careers page the "Careers at WindVeal" links open (its slug in the app). */
export const COMPANY_CAREERS_SLUG = env.VITE_COMPANY_CAREERS_SLUG ?? "windveal";
export const COMPANY_CAREERS_PATH = `/careers/${COMPANY_CAREERS_SLUG}`;

/** Sets the document title for the current page. */
export function useTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
