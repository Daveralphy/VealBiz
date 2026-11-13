/**
 * Flat drawings of what each area is for (no people, no background), drawn in the area's own colour so they sit
 * on the card and follow the business's brand colours. Colours come from classes styled in app.css:
 * c = the area colour, m = a middle shade, t = a light tint, p = paper, s = the soft shadow underneath.
 */

function gear(cx: number, cy: number, r: number, teeth = 8) {
  const pts: string[] = [];
  for (let i = 0; i < teeth * 4; i++) {
    const a = (i / (teeth * 4)) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 4 === 0 || i % 4 === 1 ? r : r * 0.78;
    pts.push(`${(cx + Math.cos(a) * rr).toFixed(1)},${(cy + Math.sin(a) * rr).toFixed(1)}`);
  }
  return `<polygon class="m" points="${pts.join(" ")}"/><circle class="p" cx="${cx}" cy="${cy}" r="${(r * 0.32).toFixed(1)}"/>`;
}

const ground = `<ellipse class="s" cx="100" cy="130" rx="66" ry="6"/>`;
const tick = (x: number, y: number) => `<path class="pl" d="M${x + 3} ${y + 7} l3.5 3.5 l6.5 -7"/>`;

const ART: Record<string, string> = {
  // A calendar with a clock: your own attendance and leave.
  me: `${ground}
    <rect class="p st" x="40" y="30" width="96" height="92" rx="12"/>
    <path class="c" d="M40 42 a12 12 0 0 1 12 -12 h72 a12 12 0 0 1 12 12 v12 h-96z"/>
    <rect class="m" x="62" y="20" width="7" height="20" rx="3.5"/><rect class="m" x="107" y="20" width="7" height="20" rx="3.5"/>
    ${[0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => `<rect class="${r === 1 && c === 1 ? "c" : r === 2 && c === 3 ? "m" : "t"}" x="${52 + c * 19}" y="${66 + r * 17}" width="13" height="10" rx="3"/>`).join("")).join("")}
    <circle class="p" cx="140" cy="98" r="26"/><circle class="ring" cx="140" cy="98" r="23"/>
    <path class="hand" d="M140 98 V84 M140 98 L150 104"/><circle class="c" cx="140" cy="98" r="3.5"/>`,

  // An organisation chart: the team and who reports to whom.
  people: `${ground}
    <path class="wire" d="M100 58 V72 M50 72 H150 M50 72 V82 M150 72 V82 M100 72 V82"/>
    <rect class="c" x="74" y="16" width="52" height="42" rx="12"/>
    <circle class="p" cx="100" cy="31" r="7.5"/><path class="p" d="M87 51 a13 11 0 0 1 26 0z"/>
    ${[24, 74, 124].map((x, i) => `<rect class="${i === 1 ? "p st" : "t"}" x="${x}" y="82" width="52" height="40" rx="12"/>
      <circle class="m" cx="${x + 26}" cy="96" r="6.5"/><path class="m" d="M${x + 14} 115 a12 10 0 0 1 24 0z"/>`).join("")}`,

  // A CV under a magnifying glass: finding the right person.
  recruitment: `${ground}
    <rect class="p st" x="44" y="14" width="84" height="108" rx="10"/>
    <rect class="t" x="56" y="26" width="24" height="24" rx="6"/><circle class="m" cx="68" cy="35" r="5"/><path class="m" d="M60 49 a8 7 0 0 1 16 0z"/>
    <rect class="c" x="88" y="29" width="30" height="6" rx="3"/><rect class="t" x="88" y="41" width="22" height="5" rx="2.5"/>
    ${[62, 73, 84, 95, 106].map((y, i) => `<rect class="t" x="56" y="${y}" width="${[60, 48, 60, 38, 52][i]}" height="5" rx="2.5"/>`).join("")}
    <circle class="lens" cx="134" cy="84" r="21"/><circle class="ring c-st" cx="134" cy="84" r="21"/>
    <path class="handle" d="M149 99 L166 116"/>`,

  // A sales funnel with coins coming out: leads becoming deals.
  crm: `${ground}
    <path class="c" d="M40 18 H160 L149 44 H51 Z"/>
    <path class="m" d="M55 51 H145 L136 74 H64 Z"/>
    <path class="t" d="M68 81 H132 L124 102 H76 Z"/>
    <circle class="gold" cx="122" cy="114" r="13"/><circle class="gold-in" cx="122" cy="114" r="8"/>
    <circle class="gold" cx="146" cy="120" r="9"/><circle class="gold-in" cx="146" cy="120" r="5"/>`,

  // A clipboard checklist: tasks and approvals moving along.
  workflows: `${ground}
    <rect class="c" x="50" y="22" width="100" height="104" rx="12"/>
    <rect class="p" x="59" y="34" width="82" height="84" rx="7"/>
    <rect class="m" x="78" y="13" width="44" height="18" rx="7"/><circle class="p" cx="100" cy="20" r="3"/>
    ${[46, 68, 90].map((y, i) => `<rect class="${i < 2 ? "c" : "box"}" x="68" y="${y}" width="15" height="15" rx="4"/>${i < 2 ? tick(68, y + 1) : ""}
      <rect class="t" x="91" y="${y + 3}" width="${[40, 32, 38][i]}" height="5" rx="2.5"/><rect class="t" x="91" y="${y + 11}" width="${[24, 28, 18][i]}" height="3" rx="1.5"/>`).join("")}`,

  // A folder with a spreadsheet sticking out: files, and bringing in spreadsheets.
  documents: `${ground}
    <path class="m" d="M30 42 a9 9 0 0 1 9 -9 H76 l11 11 H161 a9 9 0 0 1 9 9 V116 a9 9 0 0 1 -9 9 H39 a9 9 0 0 1 -9 -9 Z"/>
    <rect class="p st" x="50" y="22" width="68" height="62" rx="6" transform="rotate(-7 84 53)"/>
    <rect class="p st" x="80" y="26" width="72" height="62" rx="6"/>
    <path class="grid" d="M80 40 H152 M80 52 H152 M80 64 H152 M80 76 H152 M104 26 V88 M128 26 V88"/>
    <rect class="t" x="80" y="26" width="72" height="14" rx="6"/>
    <path class="c" d="M26 66 a9 9 0 0 1 9 -9 H165 a9 9 0 0 1 9 9 L168 117 a9 9 0 0 1 -9 8 H41 a9 9 0 0 1 -9 -8 Z"/>
    <rect class="pale" x="84" y="84" width="32" height="6" rx="3"/>`,

  // A chart going up: how the business is doing.
  insights: `${ground}
    <rect class="p st" x="36" y="22" width="122" height="100" rx="12"/>
    ${[54, 78, 102, 126].map((x, i) => `<rect class="${i === 3 ? "c" : i === 1 ? "m" : "t"}" x="${x}" y="${[80, 64, 72, 46][i]}" width="16" height="${[30, 46, 38, 64][i]}" rx="4"/>`).join("")}
    <path class="trend" d="M50 70 L80 52 L106 60 L140 32"/>
    <circle class="arrow-bg" cx="152" cy="30" r="17"/><path class="pl" d="M145 36 L159 22 M150 22 H159 V31"/>`,

  // Sliders and a gear: how the business is set up.
  settings: `${ground}
    <rect class="p st" x="34" y="32" width="104" height="88" rx="12"/>
    ${[54, 76, 98].map((y, i) => { const k = [96, 66, 114][i]!; return `<rect class="t" x="50" y="${y - 3}" width="72" height="6" rx="3"/><rect class="c" x="50" y="${y - 3}" width="${k - 50}" height="6" rx="3"/><circle class="p" cx="${k}" cy="${y}" r="8"/><circle class="ring c-st thin" cx="${k}" cy="${y}" r="8"/>`; }).join("")}
    ${gear(150, 40, 24)}`,

  // A clock on a time card: clocking in and out.
  attendance: `${ground}
    <rect class="t" x="40" y="58" width="120" height="64" rx="12"/>
    <rect class="m" x="52" y="96" width="34" height="6" rx="3"/><rect class="m" x="52" y="108" width="22" height="5" rx="2.5"/>
    <circle class="p" cx="118" cy="64" r="42"/><circle class="ring" cx="118" cy="64" r="38"/>
    ${[0, 1, 2, 3].map((i) => { const a = (i * Math.PI) / 2; return `<circle class="m" cx="${(118 + Math.cos(a) * 29).toFixed(1)}" cy="${(64 + Math.sin(a) * 29).toFixed(1)}" r="3"/>`; }).join("")}
    <path class="hand" d="M118 64 V44 M118 64 L132 72"/><circle class="c" cx="118" cy="64" r="4.5"/>
    <circle class="arrow-bg" cx="150" cy="30" r="13"/><path class="pl" d="M144 30 l4 4 l8 -8"/>`,

  // A calendar with days marked off, and a suitcase: time off.
  leave: `${ground}
    <rect class="p st" x="34" y="28" width="96" height="92" rx="12"/>
    <path class="c" d="M34 40 a12 12 0 0 1 12 -12 h72 a12 12 0 0 1 12 12 v12 h-96z"/>
    <rect class="m" x="56" y="18" width="7" height="20" rx="3.5"/><rect class="m" x="101" y="18" width="7" height="20" rx="3.5"/>
    ${[0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => `<rect class="t" x="${46 + c * 19}" y="${64 + r * 17}" width="13" height="10" rx="3"/>`).join("")).join("")}
    <rect class="m" x="65" y="81" width="51" height="10" rx="5"/>
    <rect class="c" x="128" y="70" width="44" height="50" rx="9"/><path class="wire" d="M141 70 v-8 a4 4 0 0 1 4 -4 h10 a4 4 0 0 1 4 4 v8"/>
    <rect class="pale" x="135" y="86" width="30" height="5" rx="2.5"/>`,

  // A stack of notes with things ticked off: tasks given to you.
  tasks: `${ground}
    <rect class="t" x="56" y="20" width="88" height="96" rx="10" transform="rotate(6 100 68)"/>
    <rect class="p st" x="50" y="22" width="88" height="98" rx="10"/>
    <rect class="c" x="50" y="22" width="88" height="16" rx="8"/><rect class="c" x="50" y="30" width="88" height="8"/>
    ${[50, 72, 94].map((y, i) => `<rect class="${i < 2 ? "c" : "box"}" x="62" y="${y}" width="14" height="14" rx="4"/>${i < 2 ? tick(62, y) : ""}
      <rect class="t" x="84" y="${y + 4}" width="${[42, 34, 40][i]}" height="6" rx="3"/>`).join("")}
    <path class="c" d="M146 52 l12 -12 l8 8 l-12 12 z"/><path class="m" d="M146 52 l-4 12 l12 -4 z"/>`,

  // A note and a wallet, with a coin: pay.
  pay: `${ground}
    <rect class="m" x="40" y="34" width="104" height="58" rx="10" transform="rotate(-8 92 63)"/>
    <circle class="pale" cx="92" cy="60" r="12"/>
    <rect class="c" x="52" y="58" width="112" height="64" rx="12"/>
    <rect class="t" x="126" y="78" width="42" height="24" rx="8"/><circle class="c" cx="140" cy="90" r="4"/>
    <circle class="gold" cx="66" cy="44" r="13"/><circle class="gold-in" cx="66" cy="44" r="8"/>`,

  // A path to a flag: the first steps in a new job.
  onboarding: `${ground}
    <path class="trail" d="M40 118 C70 112 64 92 94 90 S132 76 128 56"/>
    ${[[40, 118], [74, 104], [108, 86]].map(([x, y], i) => `<circle class="${i === 2 ? "m" : "c"}" cx="${x}" cy="${y}" r="7"/>${i < 2 ? `<path class="pl" d="M${x! - 3.5} ${y} l2.5 2.5 l4.5 -5"/>` : ""}`).join("")}
    <rect class="c" x="126" y="16" width="5" height="46" rx="2.5"/>
    <path class="m" d="M131 18 h34 l-8 11 l8 11 h-34 z"/>
    <ellipse class="t" cx="128.5" cy="62" rx="12" ry="4"/>`,

  // A shield with a tick: approving businesses and keeping accounts safe.
  admin: `${ground}
    <path class="c" d="M100 12 L150 30 V66 C150 98 130 117 100 126 C70 117 50 98 50 66 V30 Z"/>
    <path class="m" d="M100 24 L139 38 V67 C139 92 124 107 100 114 C76 107 61 92 61 67 V38 Z"/>
    <path class="check" d="M80 69 L95 84 L122 55"/>
    <circle class="t" cx="160" cy="96" r="6"/><circle class="t" cx="40" cy="44" r="4"/><circle class="m" cx="166" cy="56" r="3"/>`,
};

/** The SVG markup for an area (falls back to the calendar). Static strings, so it's safe to render as HTML. */
export function areaArt(key: string) {
  return `<svg viewBox="0 0 200 140" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${ART[key] ?? ART.me}</svg>`;
}
