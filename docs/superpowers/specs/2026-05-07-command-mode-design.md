# Sprint D — Command Mode (PL/SQL Developer Command Window parity) — design

**Data:** 2026-05-07
**Sprint:** D (Command Mode)
**Repos:** CE (open-source engine)
**Tier:** T3 (near-full SQL*Plus parity, ~30+ directives)
**Esforço estimado:** 5–6 semanas, decomposto em 3 ondas (D.1 / D.2 / D.3)
**Itens fora desse spec:** Sprint C ondas 2.B / 4 / 5 (em andamento paralelo)

---

## Motivação

PL/SQL Developer expõe duas janelas paralelas de execução: **SQL Window** (editor com grid de resultado) e **Command Window** (REPL estilo SQL*Plus). A SQL Window já tem parity em Veesker via `SqlEditor` + `ResultGrid`. A Command Window não tem equivalente.

Para o público-alvo de Veesker (Oracle DBAs e dev sêniors em migração de PL/SQL Developer), Command Window é **table stakes**, não diferencial. É onde o usuário:

1. Cola e roda scripts de release (`@release_v3.2.sql`) com dezenas de DDL/DML em ordem fixa.
2. Faz debug rápido de procedure usando `EXEC pkg.proc(...)` sem abrir editor.
3. Inspeciona schema com `DESC table_name` sem clicar no schema browser.
4. Define `SET LINESIZE 32767` + `SET PAGESIZE 0` + `SPOOL out.csv` pra exportar query como CSV crú.
5. Define bind variables (`VAR x VARCHAR2(50); EXEC :x := 'foo';`) reutilizáveis na sessão.
6. Roda blocos PL/SQL anônimos terminados com `/`, com `DBMS_OUTPUT.PUT_LINE` aparecendo inline.

Sem isso, todo workflow legado SQL*Plus / PL/SQL Developer obriga o user a abrir uma janela paralela do `sqlplus` no terminal — que perde audit, perde safety modal, perde Activity Ledger origin attribution.

**Por que Tier 3 (near-full parity) e não Tier 1/2:** todos os SET obscuros, COL FORMAT, BREAK/COMPUTE, AUTOTRACE são padrão em scripts SQL*Plus que circulam há 20+ anos em equipes Oracle. Cortar Tier 3 deixa scripts reais quebrando em produção quando o user copia. Para um produto que se posiciona como "Oracle development platform for the AI agent era", parity de Command Window com PL/SQL Dev é binário: ou cobre o que o user vê no PL/SQL Dev, ou não cobre.

**Por que dentro de Veesker e não delegar pra `sqlplus` externo:** se Command Window for `sqlplus` shell-out, perde-se:
- Audit chain HMAC + AES-256-GCM (Sprint B/C Onda 1.B)
- Activity Ledger origin attribution (Sprint C Onda 1.A)
- AI approval modal (Sprint C Onda 3 L2.3)
- TRUNCATE confirm modal (Sprint A)
- Dry Run mode (Sprint A)
- ProductionDetector + PSDPM hard-lock (Sprint A + Sprint C Onda 1.A)
- Encryption-at-rest do histórico (Sprint C Onda 1.B)

Reescrever Command Window dentro do Veesker é o único caminho que preserva o trust foundation construído pelos Sprints A/B/C.

---

## Escopo

**Dentro:**

- **Novo tab type `command`** no `sqlEditor` store (Svelte 5 runes), paralelo aos tabs SQL existentes.
- **`CommandWindow.svelte`** — top-level component com xterm.js host + sub-tabs Dialog/Editor.
- **Renderer xterm.js + local-echo** — line editor (cursor, ←/→, Backspace, Home/End, ↑/↓ history, copy/paste).
- **Tema xterm calibrado pra match PL/SQL Dev** — fonte mono (JetBrains Mono / Consolas), background dark configurável, ANSI colors discretos (red erro, green success).
- **Parser de directives** — lookup table dispatch (`SET`, `DESC`, `@`, `/`, `;`, `SPOOL`, `BREAK`, `COMPUTE`, `COL FORMAT`, `AUTOTRACE`, `LIST`, `SAVE`, `STORE`, `RUN`, `VAR`, `EXEC`, `PRINT`, `ACCEPT`, `DEFINE`, `UNDEFINE`, `PROMPT`, `EXIT`, `QUIT`, `EDIT`).
- **Executor** — directive handlers + roteamento pra pipeline SQL/PLSQL existente (audit, safety, AI approval).
- **Formatter tabular ASCII** — LINESIZE/PAGESIZE-aware com COL FORMAT e BREAK/COMPUTE.
- **Persistência de histórico cross-session** — nova tabela `command_history` em `veesker.db` (SQLCipher).
- **Bind variables (VAR/EXEC/PRINT)** — declaração + atribuição + impressão; substituição automática `:x` em SQL/PLSQL.
- **Substitution variables (&var, &&var, DEFINE/UNDEFINE/ACCEPT)** — substituição de macro em tempo de parse.
- **SPOOL** — gravação livre no filesystem via Tauri `fs` plugin.
- **AUTOTRACE** — segue diretiva SQL*Plus pura, independente de `auto_explain_mode` da conexão.
- **Skip HOST/!/CONNECT** — não implementados (security).
- **Sub-tabs Dialog/Editor** — wrapper Svelte ao redor do xterm; "Editor" mode = textarea grande pra colar script multi-line e disparar execute.

**Fora (Tier 4+ — futuro):**

- `COPY FROM/TO` (cross-DB copy).
- `ARCHIVE LOG`, `CONNECT`, `DISCONNECT` (admin/auth via REPL).
- `STARTUP`/`SHUTDOWN` (DB lifecycle).
- `SET TERMOUT` (já implícito no design).
- `SHOW PARAMETER`, `SHOW USER`, `SHOW SGA` (Tier 4 polish).
- Auto-complete de identificadores no input (Tier 4).
- Syntax highlighting no input line (decisão Opção A — sem highlight).
- Multi-window (mais de uma Command Window simultânea por conexão) — funciona mas histórico cross-session é por connection_id, não por janela.

---

## Design

### Camadas (tree)

```
Frontend (SvelteKit 5, Svelte 5 runes)
├── workspace/CommandWindow.svelte          NEW — top-level (xterm host + sub-tabs Dialog/Editor)
├── workspace/CommandEditorPane.svelte      NEW — textarea pra Editor sub-tab
├── workspace/SqlDrawer.svelte              MODIFIED — switch render por tab.kind
├── command/
│   ├── parser.ts                           NEW — directive parser (lookup table)
│   ├── executor.ts                         NEW — directive handlers + SQL/PLSQL routing
│   ├── formatter.ts                        NEW — tabular ASCII LINESIZE/PAGESIZE-aware
│   ├── state.svelte.ts                     NEW — per-tab Command state (rune-based)
│   ├── history.ts                          NEW — load/append em veesker.db
│   ├── bindings.ts                         NEW — bind var resolution (VAR/EXEC/PRINT)
│   ├── substitution.ts                     NEW — &var, DEFINE/UNDEFINE/ACCEPT
│   ├── spool.ts                            NEW — file write via Tauri fs
│   ├── line-editor.ts                      NEW — handcrafted xterm input handler (cursor, history, paste)
│   ├── script-runner.ts                    NEW — `@file.sql` execution loop
│   └── prompt.ts                           NEW — SQL>/2/3/4 continuation logic
├── stores/sql-editor.svelte.ts             MODIFIED — tab.kind='command' + openCommand()
└── routes/workspace/[id]/+page.svelte      MODIFIED — keymap Ctrl+Shift+N pra openCommand

Tauri Rust (src-tauri/src/)
├── persistence/store.rs                    MODIFIED — migration v7 cria command_history
└── commands.rs                             MODIFIED — command_history_load + command_history_append

Sidecar Bun (sidecar/src/)
└── (zero novas RPCs — reusa oracle.execute / oracle.describe / oracle.dbmsOutput)
```

### Tab type integration

`sqlEditor.tabs` ganha campo `kind: 'sql' | 'command'` (default `'sql'`). `SqlDrawer.svelte` faz switch:

```ts
{#if tab.kind === 'command'}
  <CommandWindow {tab} />
{:else}
  <SqlEditor … />
{/if}
```

Tabs SQL e Command coexistem na mesma tabbar. Ícone visual diferencia (chevron `>_` pra command). Botão `+` ganha menu dropdown:

```
[+] ▾
  └── New SQL Window      (Ctrl+N)
  └── New Command Window  (Ctrl+Shift+N)
```

`openCommand(connectionId)` em `sqlEditor` cria tab com `kind='command'`, inicializa `commandState` zerado, registra listener xterm.

### Renderer — xterm.js + line editor

`CommandWindow.svelte` monta xterm em `onMount`:

```ts
term = new Terminal({
  fontSize: 13,
  fontFamily: "'JetBrains Mono', 'Consolas', monospace",
  theme: { /* tema PL/SQL Dev-style */ },
  cursorBlink: true,
  scrollback: 10000,  // 2x do TerminalPanel — Command Window guarda mais
});
```

Local-echo (handcrafted, ~300 LOC em `command/line-editor.ts`) intercepta `term.onData(data)`:

| Keystroke | Ação |
|---|---|
| `\r` (Enter) | Submit linha atual ao parser |
| `` (Backspace) | Remove char antes do cursor |
| `[D` / `[C` (←/→) | Move cursor |
| `[A` / `[B` (↑/↓) | Navegar histórico |
| `` / `` (Ctrl+A / Ctrl+E) | Home / End |
| `` (Ctrl+C) | Cancela linha atual + reseta buffer block |
| `` (Ctrl+L) | Clear screen |
| Outro printable | Insere no cursor |

Prompt rendering (`command/prompt.ts`):

```
SQL>             ← prompt principal (linha vazia, modo command)
  2              ← continuation (multi-line SQL ou bloco)
  3
  4
```

Continuation prompts ficam **alinhados à direita** com width = max(SQL>, número), igual PL/SQL Dev. Cor: cinza claro (não destaque).

### Parser strategy — lookup table

`command/parser.ts` exporta `parse(line, context)`:

```ts
type Parsed =
  | { kind: 'directive'; name: string; args: string[]; raw: string }
  | { kind: 'sql_partial'; line: string }       // colectar até ;
  | { kind: 'sql_complete'; sql: string }        // ; encontrado
  | { kind: 'block_partial'; line: string }      // colectar até /
  | { kind: 'block_complete'; sql: string }      // / encontrado
  | { kind: 'execute_buffer' }                   // bare /
  | { kind: 'empty' }
  | { kind: 'parse_error'; code: string; msg: string };
```

Lookup table de directives (`DIRECTIVE_TABLE` — listagem ilustrativa, tabela final inclui também `START` (alias de `@`), `WHENEVER`, `CLEAR`, `SHOW` parcial):

```ts
const DIRECTIVE_TABLE: Record<string, DirectiveSpec> = {
  SET: { args: ['option', 'value'], parse: parseSet },
  DESC: { aliases: ['DESCRIBE'], args: ['object'], parse: parseDesc },
  '@': { args: ['file', '...rest'], parse: parseAtFile },
  '@@': { args: ['file', '...rest'], parse: parseAtFile },
  SPOOL: { args: ['filename'], parse: parseSpool },
  COL: { aliases: ['COLUMN'], args: ['name', 'spec'], parse: parseCol },
  BREAK: { args: ['...spec'], parse: parseBreak },
  COMPUTE: { args: ['...spec'], parse: parseCompute },
  VAR: { aliases: ['VARIABLE'], args: ['name', 'type'], parse: parseVar },
  EXEC: { aliases: ['EXECUTE'], args: ['...stmt'], parse: parseExec },
  PRINT: { args: ['...names'], parse: parsePrint },
  DEFINE: { args: ['name', 'value'], parse: parseDefine },
  UNDEFINE: { args: ['...names'], parse: parseUndefine },
  ACCEPT: { args: ['name', '...rest'], parse: parseAccept },
  PROMPT: { args: ['...message'], parse: parsePrompt },
  LIST: { aliases: ['L'], args: ['range?'], parse: parseList },
  SAVE: { args: ['filename', 'mode?'], parse: parseSave },
  STORE: { args: ['kind', 'filename'], parse: parseStore },
  RUN: { aliases: ['R'], args: [], parse: parseRun },
  EDIT: { aliases: ['ED'], args: ['filename?'], parse: parseEdit },
  EXIT: { aliases: ['QUIT'], args: [], parse: parseExit },
  CLEAR: { args: ['target'], parse: parseClear },
};
```

`SET option value` tem sub-table de options (~25 entries):

```ts
const SET_OPTIONS: Record<string, SetOptionSpec> = {
  LINESIZE: { type: 'int', range: [1, 32767], default: 80 },
  PAGESIZE: { type: 'int', range: [0, 50000], default: 14 },
  LONG: { type: 'int', range: [0, 2_000_000_000], default: 80 },
  LONGCHUNKSIZE: { type: 'int', range: [1, 1_000_000], default: 80 },
  SERVEROUTPUT: { type: 'enum', values: ['ON', 'OFF'], extra: 'SIZE n|UNLIMITED' },
  FEEDBACK: { type: 'enum_or_int', values: ['ON', 'OFF'], default: 6 },
  ECHO: { type: 'enum', values: ['ON', 'OFF'], default: 'OFF' },
  TIMING: { type: 'enum', values: ['ON', 'OFF'], default: 'OFF' },
  HEADING: { type: 'enum', values: ['ON', 'OFF'], default: 'ON' },
  NEWPAGE: { type: 'int_or_none', default: 1 },
  PAGES: { /* alias PAGESIZE */ },
  AUTOTRACE: { type: 'enum', values: ['ON', 'OFF', 'TRACEONLY', 'TRACEONLY EXPLAIN', 'TRACEONLY STATISTICS'] },
  AUTOPRINT: { type: 'enum', values: ['ON', 'OFF'], default: 'OFF' },
  VERIFY: { type: 'enum', values: ['ON', 'OFF'], default: 'ON' },
  DEFINE: { type: 'char_or_off', default: '&' },
  CONCAT: { type: 'char_or_off', default: '.' },
  ESCAPE: { type: 'char_or_off', default: 'OFF' },
  TRIMSPOOL: { type: 'enum', values: ['ON', 'OFF'], default: 'OFF' },
  TRIMOUT: { type: 'enum', values: ['ON', 'OFF'], default: 'ON' },
  WRAP: { type: 'enum', values: ['ON', 'OFF'], default: 'ON' },
  COLSEP: { type: 'string', default: ' ' },
  NULL: { type: 'string', default: '' },
  TERMOUT: { type: 'enum', values: ['ON', 'OFF'], default: 'ON' },
  NUMWIDTH: { type: 'int', range: [1, 50], default: 10 },
  NUMFORMAT: { type: 'string' },
  TIME: { type: 'enum', values: ['ON', 'OFF'], default: 'OFF' },
};
```

Directive desconhecido → erro `SP2-0158: unknown SET option "..."` (mantemos códigos SP2 originais do SQL*Plus pra parity de error message — usuários DBA reconhecem na hora).

### Executor strategy

`command/executor.ts` roteia parsed line:

```ts
async function execute(parsed: Parsed, state: CommandState, ctx: ExecCtx): Promise<void> {
  switch (parsed.kind) {
    case 'directive':
      return executeDirective(parsed.name, parsed.args, state, ctx);
    case 'sql_complete':
      return executeSql(parsed.sql, state, ctx);
    case 'block_complete':
      return executeBlock(parsed.sql, state, ctx);
    case 'execute_buffer':
      return executeBuffer(state, ctx);  // bare /
    case 'parse_error':
      return writeErrorLine(parsed.code, parsed.msg, state, ctx);
    case 'sql_partial':
    case 'block_partial':
      state.bufferedLines.push(parsed.line);  // acumula
      return;
    case 'empty':
      return;
  }
}
```

`executeSql` e `executeBlock` aplicam:

1. **Substitution vars**: passa SQL por `substitution.expand(sql, state.defines)` — substitui `&var` e `&&var`. Se `&var` não tem define, dispara `ACCEPT` (modal Svelte) pra pedir valor ao user.
2. **Bind vars**: extrai `:identifier` do SQL, monta map `{ identifier: state.bindVars[identifier].value }`, passa pra sidecar como bindParams.
3. **Pipeline shared**: chama `sqlEditor.runStatementShared(sql, { origin: 'user_typed', binds, ... })` — esse helper já encapsula audit chain, AI approval, TRUNCATE confirm, Dry Run, PSDPM, ProductionDetector. Não duplicamos lógica.
4. **Resultado**: rows + plan + DBMS_OUTPUT volta em estrutura conhecida → `formatter.format(rows, state.settings, state.colFormats, state.breakSpec, state.computeSpec)` → `term.write(formatted)`.
5. **SPOOL hook**: se `state.spoolFile` setado, mesmo texto vai pra append no arquivo.
6. **Status line**: `term.write(formatStatus(rowCount, elapsedMs, state.settings))` — ex: `1 row selected in 0.121 seconds.` ou `PL/SQL procedure successfully completed.`.

### Pipeline reuse — `runStatementShared`

Hoje `sqlEditor.runActiveAll()` em `sql-editor.svelte.ts` faz:

```ts
async runActiveAll() {
  const tab = this.active;
  if (!tab) return;
  await this.executeStatement({
    sql: tab.sql,
    tabId: tab.id,
    origin: 'user_typed',
    /* … */
  });
}
```

`executeStatement` é o pipeline com safety guards. Vamos extrair em método exportado `runStatementShared(sql, opts)` que NÃO depende de `tabId` específico (Command Window não tem `tab.results[]` no mesmo sentido). Retorna:

```ts
type SharedExecResult = {
  rows: any[][];
  columns: ColumnMeta[];
  rowCount: number;
  elapsedMs: number;
  dbmsOutput: string[];
  explainPlan: ExplainNode[] | null;
  error: { code: string; message: string } | null;
};
```

Command Window consome `SharedExecResult`, formata, escreve no xterm.

**Decisão chave (§3 do brainstorm):** SIM, Command Window passa pelo MESMO pipeline. Wiring separado paralelo seria duplicação custosa (e perigosa — perderia safety guards em Command Window por descuido).

### Formatter — tabular ASCII

`command/formatter.ts` exporta `formatRows(rows, columns, settings, colFormats, breakSpec, computeSpec): string`.

**LINESIZE handling:**
- Soma `displayWidth` de todas colunas + separators.
- Se total > LINESIZE: aplica WRAP (default ON) — quebra linha por coluna; ou TRUNCATE (WRAP OFF) — corta no LINESIZE.
- COL FORMAT a30 = força 30 chars para coluna VARCHAR.
- Numeric default = NUMWIDTH (10), com NUMFORMAT override.

**PAGESIZE handling:**
- A cada PAGESIZE rows, re-emit header (column titles + separator linha `------`).
- PAGESIZE 0 = sem header, sem repeat.
- HEADING OFF = sem header inicial nem repeat.

**COL FORMAT examples:**

```
COL ename FORMAT a30
COL salary FORMAT 999,999.99
COL hiredate FORMAT a12
```

Aplicado em ordem de declaração; última declaração vence. `CLEAR COLUMNS` zera.

**BREAK / COMPUTE:**

```
BREAK ON dept SKIP 1
COMPUTE SUM OF salary ON dept
```

Renderer agrupa por valor da coluna `dept`; ao mudar valor: imprime linha de `COMPUTE` (`sum`) + `SKIP 1` linha em branco. Suporta multi-level break.

**Exemplo de output (target visual):**

```
SQL> SELECT empno, ename, sal FROM emp WHERE deptno = 10;

     EMPNO ENAME             SAL
---------- ---------- ----------
      7782 CLARK            2450
      7839 KING             5000
      7934 MILLER           1300

3 rows selected in 0.045 seconds.

SQL>
```

Escolhas concretas:
- Header: column name uppercase (Oracle default), padding direita pra numeric / esquerda pra string.
- Separator: linha de `-` com mesmo width que cada coluna.
- Espaço entre colunas: COLSEP (default ` ` 1 char).
- NULL: render como string vazia (default) ou setting NULL='<null>'.

### State management — per tab

`command/state.svelte.ts`:

```ts
export interface CommandState {
  // Settings (SQL*Plus SET)
  settings: SqlPlusSettings;       // LINESIZE, PAGESIZE, FEEDBACK, etc.
  colFormats: Map<string, ColFormat>;
  breakSpec: BreakSpec | null;
  computeSpec: ComputeSpec[];

  // Substitution / binds
  defines: Map<string, string>;
  bindVars: Map<string, BindVar>;

  // Buffer
  bufferedLines: string[];          // current SQL/block being collected
  inBlockMode: boolean;             // true após BEGIN/DECLARE até /
  lastBuffer: string;               // último buffer executado (pra LIST/SAVE/RUN)

  // Spool
  spoolFile: string | null;

  // History
  history: string[];                 // últimos N comandos in-memory
  historyCursor: number;             // posição atual ↑/↓
}
```

Toda mutação é via runes — `state.settings.linesize = n` re-renderiza nada (xterm é imperativo), só afeta próximo formatRows.

### Persistência — `command_history` table

Migration v7 em `persistence/store.rs`:

```sql
CREATE TABLE IF NOT EXISTS command_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  command       TEXT NOT NULL,
  executed_at   INTEGER NOT NULL,    -- unix ms
  session_id    TEXT NOT NULL,        -- UUID per Command Window session
  origin        TEXT NOT NULL,        -- 'user_typed' | 'script_executed' | 'ai_approved' | ...
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);
CREATE INDEX idx_cmd_hist_conn_time ON command_history(connection_id, executed_at DESC);
```

Encrypted automaticamente via SQLCipher (Onda 1.B). Tauri commands:

```rust
#[tauri::command]
async fn command_history_load(connection_id: i64, limit: i64) -> Result<Vec<HistoryEntry>, String>;

#[tauri::command]
async fn command_history_append(connection_id: i64, command: String, session_id: String, origin: String) -> Result<(), String>;
```

Frontend (`command/history.ts`) chama em:
- `onMount` do CommandWindow: load N=500 últimos comandos da `connection_id` → popula `state.history`.
- Após cada submit válido: `command_history_append` → fire-and-forget.

Histórico **não distingue por session_id no LOAD** — todas as sessões anteriores aparecem, ordenado por `executed_at DESC`. Comportamento padrão de shell (bash, zsh, sqlplus).

### Sub-tabs Dialog/Editor

Wrapper Svelte ao redor do xterm:

```
┌─ [▌Dialog ▌] [ Editor ] ──────────────────┐
│                                            │
│  (xterm host se Dialog ativo,              │
│   textarea se Editor ativo)                │
│                                            │
└────────────────────────────────────────────┘
```

**Dialog mode:** xterm visível, REPL ativo.

**Editor mode:** textarea grande (re-aproveita `SqlEditor.svelte` em modo simplificado, ou textarea raw). User cola script multi-line, dá Ctrl+Enter ou clica "Execute" → texto é enviado ao parser linha-a-linha como se fosse colado no xterm. Ao terminar, switcha de volta pra Dialog mode (output já apareceu lá durante execução).

Match com PL/SQL Dev: ele tem o mesmo split. User cola script no Editor, dá F5/F8 (já temos shortcuts), output aparece no Dialog buffer.

### AI approval no Command Window

Sheep AI hoje pode chamar `run_query` etc. via tool calls. No Command Window, AI tool calls que disparariam SQL são interceptadas pelo MESMO `executeStatement` (ou `runStatementShared`), que já tem AI approval gate (Sprint C Onda 3 L2.3).

Modal aparece em cima do Command Window. Após approve/deny, output volta no buffer com origin `ai_approved` ou erro `Command denied (user denied AI approval).`.

`applyToTurn` funciona igual — próxima query AI no mesmo turno passa direto.

### TRUNCATE / unsafe DML

Quando user digita `TRUNCATE TABLE x;` no Command Window:

1. Parser detecta `;`, `executeSql` chamado.
2. `runStatementShared` detecta TRUNCATE → dispara `DmlConfirmModal` por cima do Command Window.
3. User confirma → SQL roda → output `Table truncated.` no buffer.
4. User cancela → output `Operation cancelled by user.` em vermelho.

Mesma lógica pra DML em prod sem WHERE clause (PSDPM hard-lock check).

### Dry Run

`SET DRYRUN ON` (extensão Veesker, não SQL*Plus puro) ativa dry-run mode no Command Window específico. SELECT roda normal, DML/DDL apenas estima impacto sem executar.

Decisão: incluir `SET DRYRUN ON|OFF` como extensão proprietária. Match com toggle Dry Run da Sprint A. Usuário pode também ativar via menu/shortcut antes de abrir Command Window.

### `@` script execution

`@release_v3.2.sql` carrega arquivo, processa linha a linha:

1. Tauri `fs.readTextFile(path)` → conteúdo string.
2. `command/script-runner.ts` itera por linhas.
3. Cada linha vai pelo MESMO pipeline de parser/executor que comando interativo — directives funcionam, SQL/PLSQL acumulam até `;` ou `/`, output streama no buffer.
4. **Origin attribution:** cada SQL executado vai com `origin: 'script_executed'` + `script_path` no audit entry.
5. Erros: SP2-XXXX printados inline; SQL errors podem abortar via `WHENEVER SQLERROR EXIT FAILURE` (suportado no Tier 3).
6. `@@` = `@` mas relativo ao arquivo atual (suporta scripts encadeados).

Path resolução: relativo ao diretório do app por default; absoluto OK; `~/` expandido pra home.

### `EDIT` directive

`EDIT [filename]` abre arquivo no Editor sub-tab. Sem filename, usa último buffer (`afiedt.buf` no SQL*Plus original). Veesker mapeia pra textarea no Editor sub-tab — não shells out pra `notepad`/`vi` (mantém in-app workflow).

### EXIT / QUIT

Fecha o tab Command (igual `[x]` no tabbar). Buffer + estado descartados. Histórico permanece em `command_history`.

---

## Directives reference (Tier 3 completo)

| Categoria | Directives | Comportamento |
|---|---|---|
| **SET (basic)** | LINESIZE, PAGESIZE, LONG, LONGCHUNKSIZE, FEEDBACK, ECHO, TIMING, HEADING, NEWPAGE, PAGES, VERIFY | Estado em `state.settings`; afeta render de próximas queries |
| **SET (formatting)** | NUMWIDTH, NUMFORMAT, COLSEP, NULL, WRAP, TRIMSPOOL, TRIMOUT, TIME | Estado em `state.settings`; afeta formatter |
| **SET (substitution)** | DEFINE, CONCAT, ESCAPE | Estado em `state.settings`; afeta substitution.ts |
| **SET (output)** | SERVEROUTPUT, AUTOPRINT, AUTOTRACE, TERMOUT | SERVEROUTPUT mapeia pra DBMS_OUTPUT enable/disable; AUTOTRACE dispara EXPLAIN paralelo + STATISTICS render — **NÃO consulta `auto_explain_mode` da conexão** (Sprint C Onda 3 L3.2). AUTOTRACE é state local da Command Window por sessão. |
| **SET (Veesker extension)** | DRYRUN | Toggle Dry Run mode |
| **Object inspection** | DESC[RIBE] | Chama `oracle.describe` RPC; renderiza tabular |
| **Script** | @, @@, START | Carrega arquivo, processa linha-a-linha |
| **Spool** | SPOOL filename, SPOOL OFF | Tauri fs append |
| **Buffer** | LIST, L, RUN, R, SAVE, EDIT, ED, STORE | Manipulação do `state.lastBuffer` |
| **Bind vars** | VAR/VARIABLE, EXEC/EXECUTE, PRINT | `state.bindVars` map; substitui `:x` em SQL |
| **Substitution** | DEFINE, UNDEFINE, ACCEPT | `state.defines` map; expande `&var`/`&&var` |
| **Output literal** | PROMPT | Print text no buffer |
| **Reporting** | COL/COLUMN, BREAK, COMPUTE, CLEAR | Estado em `state.colFormats` / `state.breakSpec` / `state.computeSpec` |
| **Session** | EXIT, QUIT | Fecha tab |
| **Error control** | WHENEVER SQLERROR, WHENEVER OSERROR | Affect script `@` execution |

**Codes SP2-XXXX** preservados onde aplicável (parity de error message). Lista parcial:

- `SP2-0158: unknown SET option "..."`
- `SP2-0042: unknown command "..." - rest of line ignored.`
- `SP2-0310: unable to open file "..."` (SPOOL falha)
- `SP2-0552: bind variable "..." not declared.`
- `SP2-0734: unknown command beginning "..." - rest of line ignored.`

---

## Error handling

| Cenário | Comportamento |
|---|---|
| ORA-XXXXX (Oracle error) | Red ANSI no xterm + audit entry + Activity Ledger entry com error_code preservado |
| Parser error (directive) | `SP2-XXXX: ...` inline (cinza/red dependendo da severidade) |
| `@file.sql` not found | `SP2-0310: unable to open file "file.sql"` |
| SPOOL file write error | Warning amarelo, `Error writing to spool file: <reason>`, sessão continua |
| Connection lost | `Disconnected from Oracle.` + `Use [reconnect button]` (não auto-reconnect) |
| AI approval timeout (5min) | `Operation denied (AI approval timed out).` em red |
| AI approval denied | `Operation denied by user.` em red |
| TRUNCATE / unsafe DML cancel | `Operation cancelled by user.` em red |
| PSDPM hard-lock prod block | `PSDPM-PROD-LOCK: this operation requires manual review in PROD.` em red, link pra docs |
| `EXEC` invalid (PL/SQL syntax) | ORA-06550 padrão preservado |
| `&var` sem DEFINE e ACCEPT cancelado | `Substitution variable cancelled by user.` |
| Bind var undeclared | `SP2-0552: bind variable "X" not declared.` |

---

## Testing strategy

### Vitest unit

- `parser.test.ts` — happy + malformado para cada directive (~35 directives × 2 cases = ~70 tests).
- `formatter.test.ts` — LINESIZE wrapping (40, 80, 132, 32767), PAGESIZE breaks (0, 14, 50), COL FORMAT (a30, 999,999.99), BREAK ON multi-level, COMPUTE SUM/AVG/COUNT.
- `substitution.test.ts` — `&var` (one-shot), `&&var` (sticky), `DEFINE`/`UNDEFINE`, `ACCEPT` mock.
- `bindings.test.ts` — VAR declare, EXEC assign, PRINT, `:x` substitution em SQL.
- `prompt.test.ts` — continuation prompts (2, 3, ... right-aligned).
- `line-editor.test.ts` — cursor moves, Backspace, history ↑/↓, Ctrl+A/E/L, Ctrl+C clear.

### Vitest integration (com sidecar mock)

- Round-trip simples: `SELECT * FROM dual;` → output ASCII com 1 row.
- Round-trip com SET: `SET LINESIZE 40\nSELECT * FROM all_tables WHERE rownum<3;` → output truncado em 40 col.
- Bind var fluxo: `VAR x VARCHAR2(50)\nEXEC :x := 'foo'\nPRINT x` → output `X = foo`.
- Substitution fluxo: `DEFINE owner=SCOTT\nSELECT * FROM &owner..emp WHERE rownum<2;` → SQL expandida + executada.
- Block `BEGIN/.../END;\n/` → executa, retorna `PL/SQL procedure successfully completed.`
- `@script.sql` mock — vfs em memória → executa linhas, vê DBMS_OUTPUT no buffer.
- TRUNCATE confirm modal dispara — verifica que xterm não escreve `Table truncated.` até user confirmar.
- AI approval gate dispara — sheep AI tool call no Command Window contexto vê modal, approve aplica.

### Manual smoke (gate de release Sprint D)

Roda contra Oracle 23ai Free Docker do user. Script de smoke em `ce/docs/smoke/command-mode-smoke.md` (criado durante onda D.3, datado no commit final) com checklist:

- Open Command Window → vê `Connected to Oracle Database 23.X ... Connected as <user>@<service>`
- `SELECT * FROM dual;` → `D\n-\nX\n\n1 row selected in 0.0XX seconds.`
- `DESC dual` → table description
- `SET LINESIZE 40 ; SELECT ...` → wrap correto
- `SET PAGESIZE 5 ; SELECT * FROM all_objects WHERE rownum<15;` → header repete a cada 5 rows
- `BEGIN dbms_output.put_line('hi'); END;\n/` → `hi\n\nPL/SQL procedure successfully completed.`
- `VAR x VARCHAR2(50)\nEXEC :x := 'world'\nSELECT 'hello ' || :x FROM dual;` → `hello world`
- `DEFINE n=42\nSELECT &n FROM dual;` → 42
- `@migration.sql` (3-statement script) → cada statement executa em ordem, erros abortam se WHENEVER SQLERROR EXIT
- `SPOOL /tmp/out.txt\nSELECT * FROM emp;\nSPOOL OFF` → arquivo /tmp/out.txt tem texto idêntico ao buffer
- `TRUNCATE TABLE foo;` → modal dispara, confirm executa
- AI no chat tenta `run_query` enquanto Command Window aberto → modal de aprovação aparece
- ↑/↓ navegam histórico, persistido entre sessões (close + reopen window — comandos antigos aparecem)
- `EXIT` fecha tab

---

## Decomposição em ondas (vai pro plan, não pro spec)

| Onda | Conteúdo | Esforço estimado |
|---|---|---|
| **D.1 — Core REPL** | Tab type `command`; `CommandWindow.svelte`; xterm + line-editor; `command_history` table + load/append; Tier 1 directives (SET basics, DESC, /, ;, EXIT, COMMIT/ROLLBACK, PROMPT); `@file.sql`; pipeline integration (audit, AI approval, TRUNCATE, Dry Run, PSDPM); manual smoke parcial | ~2 sem |
| **D.2 — Bind vars + substitution + SPOOL** | `VAR/EXEC/PRINT`; `:x` substitution; `&var`/`&&var`/`DEFINE`/`UNDEFINE`/`ACCEPT`; `SPOOL ... OFF`; `WHENEVER SQLERROR/OSERROR` em scripts; smoke parcial | ~1.5 sem |
| **D.3 — Reporting + buffer + sub-tabs** | `COL FORMAT`; `BREAK`/`COMPUTE`; `HEADING`/`NEWPAGE`/`NUMWIDTH`/`NUMFORMAT`; `AUTOTRACE`; `LIST`/`SAVE`/`STORE`/`RUN`/`EDIT`; sub-tabs Dialog/Editor; manual smoke completo + release Sprint D | ~2 sem |

Cada onda = um PR único na CE main. Histórico de execução de Sprints A/B/C confirma que single-PR-per-onda funciona pra esse tipo de feature size.

---

## Open questions / future

- **Multi-window por conexão**: não bloqueante mas histórico fica misturado entre janelas. Aceitável (matches shell behavior).
- **`EDIT` em arquivo externo**: por ora só sub-tab Editor. Spawn external editor (`$EDITOR`) é Tier 4.
- **`SHOW PARAMETER`/`SHOW USER`/`SHOW SGA`**: Tier 4.
- **Auto-complete no input line** (tab completion de identifier names): Tier 4. Decisão atual = sem highlight nem completion (match SQL*Plus puro = Opção A escolhida).
- **`COPY FROM/TO` cross-DB**: Tier 4 ou nunca (ferramenta legada, raramente usada).

---

## Referências

- Sprint C Onda 3 (L3.3 DBMS_OUTPUT) — `docs/superpowers/specs/2026-05-06-sprint-c-onda-3-transparency-ai-safety-design.md`
- Sprint C Onda 1.A (Activity Ledger origin attribution)
- Sprint C Onda 1.B (encryption-at-rest, SQLCipher)
- Sprint A (ProductionDetector, TRUNCATE confirm, Dry Run)
- Sprint B (HMAC audit chain)
- PL/SQL Developer Command Window reference (Allround Automations)
- SQL*Plus User's Guide and Reference (Oracle Docs 23ai)
