import { Glob } from "bun";
import { readFile } from "fs/promises";

const PT_PATTERN = /(?:não|ação|Revogar|Habilitar|configuração|\bErro\b|carregando|cancelar|criando|nenhum|módulo|usuário|salvar|consulta|senha|linha)/i;
const glob = new Glob("src/**/*.{svelte,ts}");
const hits: Array<{ file: string; line: number; match: string }> = [];

for await (const file of glob.scan(".")) {
  if (file.includes(".test.")) continue;
  const text = await readFile(file, "utf-8");
  text.split("\n").forEach((ln, i) => {
    if (PT_PATTERN.test(ln) && !ln.includes("// pt-BR")) {
      hits.push({ file, line: i + 1, match: ln.trim() });
    }
  });
}

if (hits.length) {
  for (const h of hits) console.error(`${h.file}:${h.line}: ${h.match}`);
  process.exit(1);
}
