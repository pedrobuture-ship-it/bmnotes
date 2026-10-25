# Prompts

Pedidos feitos durante o desenvolvimento, em ordem. O Client ID do GitHub OAuth App (público, sem segredo) é `Ov23li8KuIIKb5wDdfrb`.

1. Descobrir onde fica o repositório remoto do projeto.
2. Renomear o app para **bmnotes** e trocar o logo por um lobo em arte desenhada.
3. Commit e push.
4. Criar um **modo claro amarelado**, mantendo o modo escuro atual.
5. Facilitar ligar os cards: **duas bolinhas, uma de cada lado**, para puxar e ligar um card no outro.
6. Ao ligar, **escrever automaticamente o `[[link]]` dentro do `.md`**.
7. Corrigir a seta que aparecia com duas listras; deixar **só uma seta calculada**.
8. Permitir **deletar as setas** com `Delete`, apagando também a marcação dentro do `.md`.
9. Commit e push.
10. Escolher um Google Drive para backup e trabalho em dupla na mesma pasta (**plano**).
11. Comparar as opções B (rclone) e C (Git).
12. Fazer o login pelo navegador no **GitHub**, como recurso **opcional** (**plano**).
13. Salvar os prompts neste arquivo e seguir com a implementação.

## Plano de sincronização com o GitHub (opcional)

1. **Login** pelo Device Flow: código no app, autorização no navegador, token em arquivo na pasta de configuração do app (0600).
2. **Ligar a pasta a um repositório**: criar novo, escolher um existente ou colar a URL.
3. **Motor de sincronização** com o `git` do sistema: commit automático, `fetch` periódico, `push`.
4. **Conflitos**: merge de texto por linha; tela com "minha", "do outro" ou "as duas"; merge por card no `board.json`.
5. **Interface**: ícone de status no cabeçalho, painel de sincronização, aviso ao editar.
6. **Testes e documentação**.

Implementado nas fases 1 a 6 (login, ligar repositório, motor `git`, conflitos, interface, testes e README).

Tudo desligado por padrão: sem conectar, o app não faz nenhuma chamada de rede.

---

# Rodada 2 — prompts gerados

Pedido original: *"faça vários murais por pasta, escrita, busca e navegação, e qualidade e segurança; gere todos os prompts, salve na raiz e vá seguindo, não me pergunte nada, depois commit na main"*.

Cada item abaixo é um prompt autocontido; a implementação segue a ordem numérica.

## 1. Vários murais por pasta
> Permita vários murais na mesma pasta. O mural atual (`.bmnotes/board.json`) continua sendo o mural "Main", que mostra todas as notas. Murais extras ficam em `.bmnotes/boards/<id>.json` e são curados: só mostram as notas adicionadas a eles. Crie um seletor de murais (abas) na vista do mural com criar (vazio ou cópia do atual), renomear e apagar. Em murais extras, "Delete" no card só tira do mural, nunca apaga o arquivo. Adicione "Add to board" no menu da nota. O sync precisa fazer merge por card também nesses arquivos. Mantenha compatibilidade total com pastas antigas.

## 2. Modelos de nota
> Comando "New note from template". Modelos vêm da pasta `templates/` do workspace e de 3 modelos embutidos (reunião, projeto, leitura). Variáveis `{{title}}`, `{{date}}`, `{{time}}`. Um seletor com busca; depois pede o título e cria a nota já aberta.

## 3. Embeds `![[nota]]`
> Mostre o conteúdo de outra nota dentro do preview quando houver `![[nota]]`, com limite de profundidade e proteção contra ciclos, e um cabeçalho clicável para abrir a nota original. Suporte `![[nota#Seção]]` mostrando só a seção.

## 4. Links para seções `[[nota#título]]` e autocompletar
> Ao clicar num link com `#título`, abra a nota e role até a seção (preview e editor). No editor, digitar `[[` sugere notas; depois de `[[nota#` sugere os títulos daquela nota; `#` no início de uma palavra sugere tags.

## 5. Notas órfãs, menções sem link e tarefas globais
> Na página da nota, mostre "menções sem link" (outras notas que citam o título mas não linkam) com botão "Linkar". Crie uma tela de Tarefas que junte todos os `- [ ]`/`- [x]` de todas as notas, com filtro, agrupamento por nota, marcar direto na tela e abrir a nota.

## 6. Buscas salvas
> Na busca, permita salvar a consulta atual com um nome. Buscas salvas aparecem no topo da barra lateral e na paleta de comandos e reabrem a busca com a consulta preenchida. Ficam em `.bmnotes/settings.json`.

## 7. Navegação: voltar/avançar, recentes e fixadas
> Histórico de navegação (nota/mural/grafo) com `Alt+←` / `Alt+→` e botões no cabeçalho. Notas fixadas (menu de contexto "Pin") e recentes (últimas 8) no topo da lista de notas.

## 8. Propriedades (frontmatter)
> Leia o frontmatter `---\nchave: valor\n---` (valores simples e listas `[a, b]`). Crie uma tela "Propriedades" em formato de tabela (notas × propriedades) com ordenação, filtro e abrir a nota. Mostre as propriedades como chips na página da nota. Suporte `chave:valor` na busca.

## 9. Rename para links Markdown comuns
> Estenda o rename inteligente para `[texto](nota.md)` (caminhos relativos): ao renomear ou mover uma nota, recalcule o caminho relativo em todas as notas, inclusive nas que também mudaram de pasta.

## 10. Backup local em ZIP
> Comando "Back up now" que gera `nome-AAAAMMDD-HHMM.zip` da pasta (sem `.git`, `node_modules`, lixeira e backups) numa pasta escolhida. Opção de backup automático ao abrir a pasta quando o último tem mais de 24 h, mantendo os N mais recentes.

## 11. Verificador de saúde das notas
> Tela "Vault health": links quebrados (com sugestão do nome mais parecido e botões "Corrigir" e "Criar nota"), notas órfãs e notas sem título. Atualiza ao vivo.

## 12. Atalhos configuráveis
> Todos os atalhos globais passam a ser configuráveis em Configurações → Keyboard (gravar nova combinação, detectar conflito, restaurar padrão). Salvos em `.bmnotes/settings.json`.

## 13. Criptografar nota com senha
> "Encrypt note…" cifra a nota com senha (AES-GCM 256, chave derivada por PBKDF2). O arquivo guarda só o texto cifrado; a nota aparece como bloqueada (cartão e página). "Unlock" decifra para edição e lembra a senha só em memória, com botão "Lock again". Testes de ida e volta e de senha errada.

## 14. Fechamento
> Atualizar README, AUDIT e testes; rodar tsc, eslint, vitest e cargo test; commit e push na `main`.

---

# Rodada 3 — planos e prompts

Pedido: *"gere planos para isso e comece a fazer sem me perguntar nada; não bote IA no app de jeito nenhum; não interrompa o processo atual"*.
Regra do produto: **nenhuma função de IA/LLM** no app. Tudo abaixo é determinístico e local.

## Colaboração

**C1. Presença** — Plano: cada pessoa publica um commit mínimo (`{login, nota, hora}`) numa branch própria `bmnotes-presence-<login>` do repositório (force-push, sem poluir a `main`); o ciclo de sync já faz `fetch`, então basta ler as branches dos outros. Aparece "Fulano está nesta nota" na página da nota. Desligável (Sync → Presença). Expira em 3 min.
**C2. Aviso antes de conflitar** — Plano: `status()` passa a calcular `remoteChanged` (`git diff --name-only HEAD...origin/<branch>`). Se a nota aberta está nessa lista, banner "mudou no remoto" com botão "Sincronizar agora".
**C3. Compartilhar só parte** — Plano: lista de caminhos privados (por máquina) gravada num bloco gerenciado de `.git/info/exclude`; arquivos já rastreados exigem confirmação ("o outro perde a cópia") e saem do repositório com `git rm --cached`. Menu "Não sincronizar" em notas e murais.

## Mural

**M1. Linha do tempo** — Plano: vista nova que agrupa notas por dia (hoje, ontem, datas), alternando "editado" e "criado" (Rust passa a devolver `created`).
**M2. Mapa mental** — Plano: diálogo que desenha em SVG a árvore de títulos `#`/`##`/`###` da nota; clicar abre a nota na seção.
**M3. Cards com tarefas** — Plano: chip "3/5" no rodapé do card; checkboxes do card já editam o arquivo.
**M4. Snap magnético e alinhamento** — Plano: guias ao arrastar (bordas e centros dos outros cards, limiar de 6 px) + botões alinhar/distribuir na barra de seleção.
**M5. Mural como página** — Plano: exportar o mural atual para um HTML único (cards renderizados, setas em SVG, imagens embutidas, pan/zoom em JS puro).

## Conteúdo

**K1. Mermaid** — Plano: blocos ```` ```mermaid ```` renderizados no preview com `mermaid` carregado sob demanda (`securityLevel: strict`).
**K2. Fórmulas** — Plano: `remark-math` + `rehype-katex` (`$...$`, `$$...$$`), CSS e fontes locais.
**K3. Tabelas** — Plano: analisador/serializador de tabelas Markdown + editor em grade (adicionar/remover linhas e colunas, alinhamento) aberto a partir do cursor.
**K4. Anexos** — Plano: aceitar PDF e áudio no colar/soltar; áudio com player, PDF como cartão com "Abrir".
**K5. Gravar áudio** — Plano: `MediaRecorder` num diálogo (gravar/parar/inserir), salvo em `assets/`.
**K6. Datas** — Plano: tokens `@2026-11-01` viram chips no preview; vista de Calendário (mês) com notas e tarefas por dia; avisos de vencidos ao abrir.

## Produto

**P1. Instalador e atualização** — Plano: workflow do GitHub Actions (tauri-action) que gera AppImage, .deb, .exe/.msi e .dmg numa release; verificação de atualização opcional pela API de releases (sem chave de assinatura).
**P2. Plugins** — Plano: scripts `.bmnotes/plugins/*.js` locais (nunca sincronizados), executados num Worker isolado sem rede, só com a API de comandos por mensagens, e só depois de aprovação por hash.
**P3. Modo foco** — Plano: esconde cabeçalho e barra lateral; atalho próprio; `Esc` sai.
**P4. Idiomas** — Plano: dicionário `t()` com inglês e português do Brasil, seletor em Aparência, cobrindo a interface principal.
**P5. Acessibilidade** — Plano: setas navegam entre cards, Enter abre, Shift+setas movem; rótulos ARIA e região "live" anunciando a seleção.
**P6. Desempenho** — Plano: leitura paralela no Rust, limite para arquivos gigantes e teste de carga com milhares de notas; índice em disco só se as medidas pedirem.

## Estado da rodada 3

Implementado: C1 presença, C2 aviso de mudança remota, C3 arquivos privados, M1 linha do tempo, M2 mapa mental, M3 progresso de tarefas nos cards,
M4 guias/alinhar/distribuir, M5 exportar HTML, K1 mermaid, K2 fórmulas, K3 editor de tabelas, K4 PDF/áudio, K5 gravação de áudio, K6 datas e calendário,
P1 workflows de release/CI e verificação de atualização, P2 plugins em sandbox, P3 modo foco, P4 idiomas (EN/PT-BR), P5 navegação por teclado e leitor de tela,
P6 leitura paralela e teste de carga. Detalhes e limites no `AUDIT.md` (seção 7).
