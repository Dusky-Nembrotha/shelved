/** Hand-tuned 20px line icons: one stroke weight, one visual language. */
const PATHS: Record<string, JSX.Element> = {
  home: <><path d="M3 10.2 12 3l9 7.2" /><path d="M5.5 9.3V20h13V9.3" /></>,
  film: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M8 4v16M16 4v16M3 12h18M3 8h5M16 8h5M3 16h5M16 16h5" /></>,
  tv: <><rect x="2.5" y="6" width="19" height="12.5" rx="2.5" /><path d="M8 3l4 3 4-3" /></>,
  book: <><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v18H5.5A1.5 1.5 0 0 1 4 19.5z" /><path d="M8 3v18" /></>,
  headphones: <><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="2.5" y="13" width="4.5" height="7" rx="2" /><rect x="17" y="13" width="4.5" height="7" rx="2" /></>,
  disc: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.6" /></>,
  note: <><circle cx="7" cy="18" r="3" /><circle cx="18" cy="16" r="3" /><path d="M10 18V6l11-2v12" /></>,
  mic: <><rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5M8.5 21.5h7" /></>,
  gamepad: <><path d="M7.5 7.5h9a5.5 5.5 0 0 1 5.5 5.5 4 4 0 0 1-7.2 2.4l-.6-.9H9.8l-.6.9A4 4 0 0 1 2 13a5.5 5.5 0 0 1 5.5-5.5Z" /><path d="M7 12h2.5M8.25 10.75v2.5M15.5 11.5h.01M17.5 13h.01" /></>,
  play: <><path d="M8 5.6v12.8a.6.6 0 0 0 .92.5l10-6.4a.6.6 0 0 0 0-1l-10-6.4A.6.6 0 0 0 8 5.6Z" /></>,
  dice: <><rect x="3.2" y="3.2" width="17.6" height="17.6" rx="4" /><path d="M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01" /></>,
  star: <><path d="M12 3.6l2.6 5.5 6 .8-4.4 4.1 1.1 5.9-5.3-2.9-5.3 2.9 1.1-5.9L3.4 9.9l6-.8z" /></>,
  sparkle: <><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></>,
  inbox: <><path d="M3 13.5 5.5 5h13L21 13.5V19a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19z" /><path d="M3 13.5h5l1.2 2.5h5.6L16 13.5h5" /></>,
  list: <><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></>,
  chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  import: <><path d="M12 3v11m0 0 4-4m-4 4-4-4" /><path d="M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17" /></>,
  settings: <><circle cx="12" cy="12" r="3.2" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  check: <><path d="M4 12.5l5 5L20 6.5" /></>,
  x: <><path d="M6 6l12 12M18 6 6 18" /></>,
  chevronLeft: <><path d="M14.5 5 8 12l6.5 7" /></>,
  chevronRight: <><path d="M9.5 5 16 12l-6.5 7" /></>,
  arrowDown: <><path d="M12 4v15m0 0 5.5-5.5M12 19l-5.5-5.5" /></>,
  arrowUp: <><path d="M12 20V5m0 0 5.5 5.5M12 5 6.5 10.5" /></>,
  chevronDown: <><path d="M5 9.5 12 16l7-6.5" /></>,
  heart: <><path d="M12 20s-7.5-4.6-7.5-9.6A4.4 4.4 0 0 1 12 7.4a4.4 4.4 0 0 1 7.5 3c0 5-7.5 9.6-7.5 9.6Z" /></>,
  refresh: <><path d="M20 11.5A8 8 0 0 0 6 7L4 9" /><path d="M4 4.5V9h4.5" /><path d="M4 12.5A8 8 0 0 0 18 17l2-2" /><path d="M20 19.5V15h-4.5" /></>,
  pencil: <><path d="M4 20h4L20 8l-4-4L4 16z" /><path d="M14.5 5.5 18.5 9.5" /></>,
  trash: <><path d="M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13" /></>,
  external: <><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v5.5A1.5 1.5 0 0 1 16.5 21h-11A1.5 1.5 0 0 1 4 19.5v-11A1.5 1.5 0 0 1 5.5 7H11" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5.5l3.5 2" /></>,
  repeat: <><path d="M4 8h12l-3-3M20 16H8l3 3" /></>,
  filter: <><path d="M3 6h18M6 12h12M10 18h4" /></>,
  grid: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  rows: <><path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17" /></>,
  upload: <><path d="M12 15V4m0 0L8 8m4-4 4 4" /><path d="M4 16v3.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V16" /></>,
  key: <><circle cx="8" cy="15" r="4.5" /><path d="M11.2 11.8 20 3M17 6l2.5 2.5M14.5 8.5 17 11" /></>,
  menu: <><path d="M3 6h18M3 12h18M3 18h18" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" /></>,
  moon: <><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" /></>,
}

export function Icon({ name, size = 20, className, strokeWidth = 1.6 }: {
  name: keyof typeof PATHS | string
  size?: number
  className?: string
  strokeWidth?: number
}) {
  const path = PATHS[name] || PATHS.star
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {path}
    </svg>
  )
}
