# Plano: migrar para Supabase e rodar no navegador

> Status: **proposta, nada implementado.** Documento de análise da stack e do caminho de migração.

## Objetivo

Trocar o armazenamento local (pasta de arquivos `.md`) por um backend online (Supabase), permitindo usar o app
**no navegador**, sem depender do Tauri. O conteúdo das notas continua sendo Markdown, só que guardado no banco.

## Stack atual

| Camada | Tecnologia |
|---|---|
| Desktop | Tauri 2 (Rust, ~3k linhas): filesystem, watcher, lixeira, backup ZIP, sync git/GitHub, presença |
| Frontend | React 19, Zustand, @xyflow/react (mural), CodeMirror 6, unified/remark/rehype, mermaid, KaTeX (~11k linhas de TS) |
| Dados | Pasta de `.md` + `.mural/*.json` (layout dos murais, settings) + `assets/` (imagens, PDF, áudio) |

**A costura natural é `src/lib/ipc.ts`.** Todo acesso ao backend passa por ele (~50 pontos de chamada em 24 arquivos).
Fora dele, a única dependência de Tauri está na URL de imagens `mural://localhost/`
(`src/lib/markdown.ts:22`, `src/lib/exportBoard.ts`, `src/lib/exportAction.ts`).

## Decisão de formato: manter Markdown, mudar o armazenamento

- **Recomendado:** o texto continua em Markdown, numa coluna do banco. Editor, preview, wiki links, tags, tarefas,
  frontmatter, busca, mind map e timeline (`src/lib/*`) trabalham sobre a string de conteúdo e continuam iguais.
- **Não recomendado:** abandonar o formato Markdown (ex.: editor rich-text/JSON). Equivale a reescrever a camada `lib/`.

## Mapeamento Tauri → Supabase

| Hoje | Depois |
|---|---|
| `.md` em pasta | tabela `notes` (conteúdo em Markdown) |
| Hierarquia de pastas | tabela `folders` ou coluna `path` |
| `.mural/board.json`, `boards/*.json` | tabela `boards` (JSONB) |
| `.mural/settings.json` | tabela `settings` (por usuário/workspace) |
| `assets/` | Supabase Storage + URL assinada |
| Lixeira em `.mural/trash/` | soft-delete (`deleted_at`) |
| Backup ZIP | export (download via `Blob`) |
| Watcher (`onFsChange`) | Supabase Realtime |
| Presença ("quem está na nota") | Realtime Presence |
| Sync GitHub, merge de board, login GitHub | **removidos** (`src-tauri/src/sync/*`, `github/`) |
| Check de update | removido no navegador |
| Escolher pasta | escolher workspace da conta |
| Mostrar no explorador / copiar caminho | removido (ou "copiar link da nota") |
| Notas criptografadas (AES-GCM) | continuam, cifradas no cliente; o banco guarda o ciphertext |
| CSP (`connect-src`) | liberar o domínio do Supabase |

## Esforço por parte

| Parte | Esforço |
|---|---|
| Schema + RLS + auth | baixo/médio |
| Reescrever `ipc.ts` para Supabase | médio |
| **Identidade da nota: path → id estável** (stores, links, boards, rename, wikiResolve, testes) | **alto** |
| Realtime no lugar do watcher e da presença | médio |
| Lixeira, export, importador de pastas `.md` existentes | médio |
| Offline (PWA + IndexedDB + fila de escrita) | **alto**, opcional |
| Remover sync git/GitHub do Rust | só deletar |

### Maior risco: a nota *é* o caminho

Hoje cards, links, murais, pins e recentes são indexados por path (`projects/app.md`). No banco, a nota precisa de
`id` estável, com `path`/`title` como colunas. Afeta `stores/workspace.ts`, `stores/board.ts`, `lib/renameLinks.ts`,
`lib/wikiResolve.ts` e os testes (`lib.test.ts`, `stores.test.ts`). Renomear/mover pasta vira operação em lote.

## Rodando no navegador

Quase gratuito depois da troca de armazenamento: o app já é um site Vite que o Tauri apenas embrulha.

- **Funciona igual:** React, mural, CodeMirror, preview, mermaid, KaTeX, busca, i18n, gravação de áudio (`MediaRecorder`),
  colar/arrastar arquivos (viram upload ao Storage).
- **Exportações** viram download via `Blob`.
- **Hospedagem:** frontend estático (`vite build`) em Vercel/Netlify/Cloudflare Pages; backend é só o Supabase.
- **Atalhos:** o navegador já reserva alguns (Ctrl+P imprime, Ctrl+K foca a barra, Ctrl+W fecha a aba). Parte dá para
  interceptar com `preventDefault`, parte não; talvez seja preciso trocar padrões.
- **Mobile:** leitura e edição básica; o mural foi desenhado para desktop.
- **Duas distribuições possíveis:** o mesmo código como site e empacotado no Tauri, trocando só a implementação do `ipc.ts`.

## Consequências de produto

- Perde-se "edite os mesmos arquivos no VS Code/Obsidian" e "sem conta, sem servidor". README, onboarding e a seção
  "Online only when you want" precisam ser reescritos.
- Sem offline, o app depende de rede, a menos que se faça PWA com cache e fila de sincronização (reintroduz conflitos).
- **Segurança:** todo acesso vem do cliente; as políticas **RLS** são a única barreira entre usuários e precisam de testes.

## Plano em fases (sugerido)

1. **Abstrair o storage.** Definir uma interface `Storage` em cima de `ipc.ts`; manter a implementação Tauri atual.
2. **Identidade por id.** Migrar stores, links e boards de path para id, ainda sobre o backend local (testes garantem a paridade).
3. **Schema Supabase + auth + RLS.** Tabelas `workspaces`, `folders`, `notes`, `boards`, `settings`, bucket de assets.
4. **Implementação `SupabaseStorage`** (CRUD, assets, soft-delete) e seleção do backend por build/configuração.
5. **Realtime:** substituir watcher e presença.
6. **Build web:** ajustar CSP, atalhos, exports e URLs de assets; remover o que é só desktop.
7. **Importador** de pasta `.md` existente (e exportador de volta para `.md`/ZIP, para não prender o usuário).
8. **(Opcional) PWA offline** com IndexedDB e fila de escrita.
9. **Documentação:** reescrever README e onboarding para o novo modelo.

## Pontos em aberto

- Modo único (só online) ou manter também o modo local/Tauri?
- Colaboração entre usuários (compartilhar workspace) ou conta individual?
- Offline é requisito?
- Plugins (hoje lidos do disco): armazenar no banco, ou desativar na versão web?
