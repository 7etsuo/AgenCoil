/**
 * Display-name filter. Matches a short list of common English slurs and
 * profanity, including spaced or symbol-substituted spellings, and masks the
 * whole name rather than trying to be clever about it.
 */
const BLOCKED = [
  "nigg",
  "fag",
  "retard",
  "kike",
  "spic",
  "chink",
  "tranny",
  "cunt",
  "rape",
  "hitler",
  "nazi",
  "fuck",
  "shit",
  "bitch",
  "whore",
  "slut",
  "dick",
  "cock",
  "pussy",
  "porn",
  "sex",
];

const SUBS: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "!": "i",
};

function normalize(name: string): string {
  return name
    .toLowerCase()
    .split("")
    .map((c) => SUBS[c] ?? c)
    .join("")
    .replace(/[^a-z]/g, "");
}

/** Returns the name, or an empty string when it should be replaced. */
export function cleanName(name: string): string {
  const flat = normalize(name);
  for (const bad of BLOCKED) if (flat.includes(bad)) return "";
  return name;
}
