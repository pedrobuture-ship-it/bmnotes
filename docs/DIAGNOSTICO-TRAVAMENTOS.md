# Diagnóstico dos travamentos — 25/10/2026

Análise do código atual, registros locais, testes existentes e reproduções isoladas.
O diagnóstico inicial foi realizado sem alterar o app. As correções posteriores
estão descritas ao final. Os experimentos usaram arquivos sintéticos em `/tmp`,
sem abrir nem modificar as notas do usuário.

## 1. Crítico: o monitor de arquivos alimenta seus próprios eventos

Em `src-tauri/src/watcher/mod.rs:49`, o processamento não descarta
`EventKind::Access`. Qualquer evento de um Markdown existente entra em `changed`.
Na linha 79, o monitor chama `read_to_string` para comparar o hash do conteúdo.
Essa leitura produz outro `Access(Open(Any))`, que volta à mesma fila.

Reprodução no Linux desta máquina com a biblioteca `notify` já compilada no projeto:

1. Criar uma nota temporária e iniciar `recommended_watcher` recursivo.
2. Ler a nota uma única vez, como ocorre no carregamento inicial.
3. Agrupar os eventos com a mesma espera de 150 ms usada pelo app.
4. Reler os caminhos Markdown, como faz o monitor.

Resultado: seis lotes consecutivos de `Access(Open(Any))`, sem novas edições.
O experimento foi limitado a seis lotes; o ciclo continuava produzindo eventos.

O filtro de gravações próprias não resolve: a leitura acontece antes da decisão
de ignorar o conteúdo. Para uma nota sem hash de gravação própria, também há
emissão repetida de `fs-change`; o frontend relê a nota e atualiza seu estado em
`src/stores/workspace.ts`, aumentando o trabalho.

**Correção prioritária:** descartar eventos de acesso antes de enfileirar/processar
arquivos e aceitar somente os tipos de criação, alteração e remoção relevantes.
Verificar em regressão que ler uma nota não produz `fs-change` e que alterações
externas reais continuam sendo detectadas.

## 2. Alto: salvamentos próprios causam varreduras completas

`filesystem/ops.rs:138` salva atomicamente com arquivo temporário + `fsync` + rename.
O teste com esse procedimento produziu `Modify(Name(To))` e `Modify(Name(Both))`
para o caminho final. O monitor define `structure = true` antes da comparação de
hash (`watcher/mod.rs:64`). Mesmo filtrando o conteúdo próprio, esse indicador
permanece verdadeiro e o evento é emitido.

O frontend responde com `queueSync`, que varre a pasta inteira, reconstrói o índice
completo e sincroniza os cartões (`workspace.ts:113–133`). A fila serializa as
varreduras, mas não reúne solicitações redundantes. No grafo aberto, o novo índice
também dispara novamente o cálculo descrito abaixo.

**Correção:** distinguir a substituição atômica de um arquivo existente de uma
mudança estrutural real; agrupar solicitações de varredura e preservar o índice
quando a estrutura não mudou. Manter a atualização normal para notas novas.

## 3. Alto: prévia de Markdown bloqueia a interface durante a digitação

`Preview.tsx:72` calcula o HTML durante o render do React; `markdown.ts:241` usa
`processSync`, incluindo matemática, destaque de código e outras transformações.
Quando o conteúdo muda, há nova conversão. O modo inicial é `split`
(`stores/ui.ts:169`), portanto digitar também atualiza a prévia.

Medições isoladas da função real com texto sintético contendo títulos, links,
listas de tarefas e fórmulas:

| Tamanho | Tempo de conversão |
| --- | ---: |
| 3.550 caracteres | 70,9 ms |
| 17.750 caracteres | 177,5 ms |
| 71.000 caracteres | 652,8 ms |

São tempos em Node nesta máquina, não medições da janela WebKit; não incluem
inserção do HTML, layout ou pintura. Demonstram o custo síncrono da operação,
mas o tempo exato no app depende das notas e do ambiente.

**Correção:** converter fora da thread da interface, com worker, descartar
resultados obsoletos e limitar a frequência de atualização da prévia.
Usar o modo de edição sem prévia reduz esse custo enquanto isso.

## 4. Alto em pastas grandes: grafo calcula todos os pares na interface

`GraphExplorer.tsx:20–22` compara todos os pares de nós em cada iteração.
`layout` é executado dentro de `useMemo` durante o render (linha 87), sem ceder
tempo à interface. O cálculo se repete quando o índice `meta` muda.

Medições do algoritmo extraído do arquivo atual, com as posições iniciais e
quantidade de iterações do próprio app e uma cadeia de links sintética:

| Notas | Tempo de cálculo |
| --- | ---: |
| 100 | 13,2 ms |
| 500 | 99,2 ms |
| 1.500 | 829,8 ms |
| 3.000 | 841,9 ms |
| 5.000 | 2.707,4 ms |

O app reduz de 220 para 60 iterações acima de 1.500 notas, explicando o tempo
parecido em 1.500 e 3.000. Estes números não incluem renderizar os elementos SVG.

**Correção:** executar layout em worker, usar aproximação espacial para evitar
todos os pares e evitar recalcular quando as conexões não mudam.

## Verificações e limites

- `npm run check`: TypeScript, ESLint e 91 testes passaram.
- Reconstrução completa de índice sintético: 25,2 ms para 1.000 notas e 117,0 ms
  para 5.000. Atualização de uma nota: 9,0 ms e 30,9 ms, respectivamente. Isso
  não inclui varredura de disco nem as renderizações disparadas pela atualização.
- Não há core dump de `buturenotes` na lista consultada dos últimos sete dias.
- A consulta ao journal não mostrou OOM nem erro de WebKit associado ao app no
  período consultado. Havia cerca de 22 GiB de memória disponível e swap sem uso
  durante a análise; isso não prova qual era o consumo no momento dos travamentos.
- `cargo test --offline` não chegou a executar os testes: o cache de build aponta
  para permissões Tauri em `/home/buture/Documents/mural-md/...`, caminho antigo
  ausente. Uma compilação em diretório novo deve preceder a validação de correções.
- Não foi capturado um travamento na janela real nem estabelecida relação com
  uma ação específica do usuário. O ciclo de eventos e os custos acima foram
  reproduzidos isoladamente; encerramentos inesperados exigem evidência adicional.

Ordem recomendada: corrigir o ciclo de acesso do monitor, eliminar varreduras de
salvamentos próprios, mover a prévia para worker e otimizar o layout do grafo.


## Correções implementadas e validação

- O monitor filtra eventos de acesso antes de enfileirá-los. O hash de um
  salvamento próprio também suprime o falso evento estrutural do rename atômico.
  O agrupamento de eventos tem prazo máximo para não adiar atualizações durante
  atividade contínua.
- As varreduras concorrentes são agrupadas; uma varredura sem mudanças preserva
  o índice e as identidades das notas. Leituras de notas novas têm concorrência
  limitada a oito, e os resultados são incorporados ao estado mais recente.
- Leituras de disco, varreduras, salvamentos de notas e gravação de metadados
  foram movidos para tarefas bloqueantes fora do ciclo da interface nativa.
- Salvamentos simultâneos da mesma nota são serializados; flush também aguarda
  gravações já em andamento. Leituras externas não sobrescrevem texto digitado
  enquanto o IPC estava pendente.
- A conversão de Markdown usa worker compartilhado, atraso de 120 ms, cancelamento
  de revisões obsoletas, timeout e cache limitado em tamanho. As dependências
  usam seus exports compatíveis com workers, sem depender de `document`.
- O grafo calcula posições em outro worker, usa uma grade espacial para evitar
  comparações de pares distantes e só recalcula quando mudam caminhos/conexões.
  O SVG monta apenas nós e arestas próximos à área visível.
- Blocos fora da área de rolagem da prévia usam `content-visibility` para reduzir
  trabalho de layout/pintura. A navegação para títulos aguarda o HTML assíncrono.

Medição isolada do novo algoritmo, com o mesmo tipo de entrada sintética do
original: 1.500 notas em 458,4 ms e 5.000 em 392,3 ms. O caso de 5.000 caiu de
2.707,4 para 392,3 ms nesta execução, além de sair da thread da interface.
São amostras locais, não garantia de tempo para qualquer pasta.

No teste real em Chromium com IPC simulado, 1.500 notas abriram, a prévia grande
foi processada por worker, a edição mais recente apareceu e não houve exceções
JavaScript. Checkboxes interativos e navegação para títulos também passaram.
Os dois workers do build de produção foram carregados e executados no navegador.
Após a redução de layout/SVG, os maiores intervalos medidos no ciclo
da interface foram 72 ms na atualização da nota e 187 ms na abertura do grafo.
Ainda existe custo de montar o HTML/SVG e de atualizar o editor; esses números
não equivalem a travamento zero, nem medem a janela WebKitGTK nativa.

O projeto foi padronizado como `bmnotes`, incluindo pacotes, executável,
identificador `app.bmnotes`, interface, protocolo `bmnotes://`, documentação,
API de plugins, nomes de branches de presença e diretório `.bmnotes/`.
A abertura de uma pasta antiga migra `.mural/` sem sobrescrever `.bmnotes/`
existente. Marcadores criptografados antigos, API antiga de plugins e blocos
antigos de arquivos privados continuam reconhecidos.

Verificações: TypeScript, ESLint, 101 testes frontend e 38 testes Rust passaram.
Os testes Rust incluem monitor real de filesystem sem realimentação, detecção de
edições externas e migração de layout/configuração/lixeira. O build Tauri de
produção sem instaladores também compilou o executável `bmnotes`. O cache antigo
de permissões Tauri foi recompilado para resolver os caminhos obsoletos.
