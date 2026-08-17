// One-shot: lift the dashboard/player pages out of the old dashboard.ts
// template literals into src/web/*.html, evaluating them the way JS would so
// escapes (\/ inside a regex, etc.) come out exactly as the browser saw them.
//
// Kept in the repo only as the record of how the extraction was done; it reads
// the pre-extraction file out of git, so it is not part of the build.
import { writeFileSync } from "node:fs";

const src = await Bun.$`git show HEAD:src/dashboard.ts`.text();

function evalTemplate(marker: string): string {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const bodyStart = start + marker.length;
  const end = src.indexOf("`;", bodyStart);
  if (end < 0) throw new Error(`unterminated template for ${marker}`);
  const raw = src.slice(bodyStart, end);
  // The literal has no ${} interpolation (verified separately), so evaluating
  // it just applies escape processing.
  return new Function(`return \`${raw}\`;`)() as string;
}

writeFileSync("src/web/dashboard.html", evalTemplate("const HTML = `"), "utf8");
writeFileSync("src/web/player.html", evalTemplate("const hlsPlayerHtml = `"), "utf8");
console.log("wrote src/web/dashboard.html and src/web/player.html");
