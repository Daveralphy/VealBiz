/* Simple platform marks for the download page (single colour, inherit currentColor). */
type P = { size?: number };

export function WindowsIcon({ size = 24 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M2 4.6 10 3.5v7.9H2V4.6Zm9-1.2L22 2v9.4H11V3.4ZM2 12.5h8v7.9l-8-1.1v-6.8Zm9 0h11V22l-11-1.5v-8Z" />
    </svg>
  );
}

export function AppleIcon({ size = 24 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.1-1.2 2.9-2.4.9-1.3 1.3-2.7 1.3-2.7s-2.4-1-2.4-4ZM14 5.5c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1 .1 2.1-.6 2.8-1.4Z" />
    </svg>
  );
}

export function AndroidIcon({ size = 24 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.6 9.5 19.4 6.4a.4.4 0 0 0-.7-.4l-1.8 3.1A11 11 0 0 0 12 8a11 11 0 0 0-4.9 1.1L5.3 6a.4.4 0 0 0-.7.4l1.8 3.1C3.6 11 1.7 13.8 1.5 17h21c-.2-3.2-2.1-6-4.9-7.5ZM7 14.3a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm10 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
    </svg>
  );
}

export function LinuxIcon({ size = 24 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2c-2.2 0-3.6 1.9-3.6 4.4 0 1.5.4 2.6-.5 4.1-1 1.6-2.9 3.7-2.9 6.4 0 .7.1 1.3.4 1.9-.9.4-1.6.9-1.4 1.6.3 1 2.5.8 3.9 1.3 1.1.4 2.2.3 2.6-.6h3c.4.9 1.5 1 2.6.6 1.4-.5 3.6-.3 3.9-1.3.2-.7-.5-1.2-1.4-1.6.3-.6.4-1.2.4-1.9 0-2.7-1.9-4.8-2.9-6.4-.9-1.5-.5-2.6-.5-4.1C15.6 3.9 14.2 2 12 2Zm-1.4 4.2c.4 0 .7.5.7 1.1 0 .6-.3 1.1-.7 1.1s-.7-.5-.7-1.1c0-.6.3-1.1.7-1.1Zm2.8 0c.4 0 .7.5.7 1.1 0 .6-.3 1.1-.7 1.1s-.7-.5-.7-1.1c0-.6.3-1.1.7-1.1ZM12 9.2c.9 0 2 .6 2 1.1 0 .4-1.1 1.2-2 1.2s-2-.8-2-1.2c0-.5 1.1-1.1 2-1.1Z" />
    </svg>
  );
}
