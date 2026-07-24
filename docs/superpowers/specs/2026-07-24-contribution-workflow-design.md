# Fluxo de contribuição para transcrições

## Objetivo

Permitir que pessoas técnicas e não técnicas proponham correções de falas,
nomes próprios, citações, pontuação e marcações de tempo sem criar
divergências entre JSON, Markdown, índice e manifesto.

## Decisão

O JSON em `json/tos-NNN.json` é a única fonte editorial canônica. Markdown,
`indice.json` e `MANIFEST.sha256` são derivados e nunca devem ser editados
diretamente.

Foram rejeitadas duas alternativas:

- editar JSON diretamente sem ferramenta, porque os arquivos são grandes e
  os dados por palavra são frágeis;
- editar JSON e Markdown, porque isso duplica a autoridade e permite drift.

## Fluxos de contribuição

### Pessoas não técnicas

Um formulário de issue solicita:

- episódio;
- tempo aproximado;
- trecho atual;
- correção proposta;
- categoria da correção;
- evidência verificável, quando houver.

Um mantenedor aplica a correção com a ferramenta guiada e vincula o pull
request à issue.

### Pessoas técnicas

O comando `npm run corrigir -- --episodio NNN` localiza um segmento por ID,
timestamp ou trecho esperado. A ferramenta exige o texto atual como guarda,
mostra uma prévia e só grava após confirmação explícita.

O colaborador altera o JSON canônico. Em seguida, `npm run sync` regenera
atomicamente Markdown, índice e manifesto.

## Invariantes

- IDs de episódios são `001` a `296`.
- IDs de segmentos são únicos e ordenados.
- Palavras possuem texto não vazio e timestamps não decrescentes.
- Tempos de palavras e segmentos ficam dentro da duração do episódio.
- `segment.text` é derivado das palavras.
- `fullText` é derivado dos segmentos.
- Trocas com a mesma quantidade de palavras preservam timestamps.
- Inserção ou remoção de palavras exige timestamps explícitos; a ferramenta
  nunca inventa alinhamento.
- Alterações de quantidade de palavras ou timestamps exigem revisão humana.
- Markdown, índice e manifesto correspondem exatamente ao JSON canônico.

## Automação

`npm run sync` usa staging e promoção com rollback. O CI executa uma
sincronização em diretório temporário e compara o resultado com a árvore
versionada; qualquer diferença falha o workflow.

`npm run verify` continua bloqueando áudio, imagens, conteúdo de site,
symlinks, arquivos fora da allowlist e violações de tamanho, além de validar
o esquema e as relações word → segment → fullText.

## Documentação

`CONTRIBUTING.md` será a entrada principal. O README apontará para o guia e
passará a descrever os JSON como importação original byte a byte com
correções editoriais versionadas.

