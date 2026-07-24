# Como contribuir

Você ajuda a tornar este acervo mais fiel ao áudio quando propõe mudanças
pequenas, verificáveis e respeitosas. O JSON em [`json/`](json/) é a fonte
canônica: o Markdown, o índice e o manifesto são artefatos derivados.

## Que correções cabem aqui

Abra uma proposta para corrigir uma ou mais destas categorias:

- **fala**: palavra, expressão ou trecho ouvido de modo incorreto;
- **nome próprio**: pessoa, lugar, obra, instituição ou sigla;
- **citação**: formulação atribuída a uma fonte;
- **pontuação**: pontuação que altera a leitura do que foi dito;
- **timestamp**: início de uma palavra ou de um segmento; e
- **identificação de locutor**: quando o trecho permite identificar com
  segurança quem fala.

Não reescreva o conteúdo para melhorar estilo, atualizar opiniões ou resumir
uma fala. Registre apenas o que pode ser sustentado pela gravação e pelas
fontes.

## Evidência necessária

Informe o episódio, um timestamp e o trecho atual. Para cada alteração, use a
melhor evidência disponível nesta ordem:

1. timestamp do episódio, acompanhado da gravação quando você a consultou;
2. fonte primária citada no episódio;
3. edição e página de livro ou artigo; e
4. referência externa confiável.

Explique a ligação entre a evidência e o texto proposto. Uma fonte externa não
substitui o áudio quando a alteração é sobre o que foi efetivamente dito.

## Caminho sem programação

1. Abra uma [correção de transcrição](https://github.com/LevyDeSales/trueoutspeak-transcricoes/issues/new?template=correcao-transcricao.yml).
2. Preencha episódio, timestamp, texto atual, texto proposto, categoria e
   evidência.
3. Confirme que a proposta foi feita de boa-fé e aguarde a revisão.

Você não precisa editar arquivos nem preparar um pull request. Um mantenedor
avaliará a proposta e poderá pedir mais contexto.

### Exemplos de relato

**Bom:** “TOS-007, 00:01–00:04, segmento `seg-0001`: o texto atual é
`Primeiro trecho.`; proponho `Outro texto.`. Categoria: fala. Ouvi o trecho na
gravação e as duas palavras ocorrem entre 0 s e 1 s.”

**Insuficiente:** “No episódio 7 há vários erros; corrijam `Primeiro trecho.`.”
Esse relato não informa timestamp, texto proposto nem evidência.

## Caminho técnico

Use Node.js 22 ou superior. Depois de criar uma issue, faça um fork, crie uma
branch e instale as dependências:

```bash
npm ci
```

Edite somente os arquivos JSON afetados em [`json/`](json/) por meio de
`npm run corrigir`. O comando atualiza os artefatos derivados automaticamente.
Para correções de **timestamp de segmento** ou de **identificação de locutor**,
use somente o [formulário de issue](https://github.com/LevyDeSales/trueoutspeak-transcricoes/issues/new?template=correcao-transcricao.yml): não envie
pull request técnico nem edite o JSON diretamente. O formato atual não possui
um campo de locutor, e a CLI não altera `startSeconds` ou `endSeconds` de
segmentos. Esse fluxo será reavaliado quando o formato e a CLI oferecerem esse
suporte.

Não edite manualmente:

- [`markdown/`](markdown/);
- [`indice.json`](indice.json);
- [`MANIFEST.sha256`](MANIFEST.sha256);
- [`temporal-anomalies.json`](temporal-anomalies.json);
- arquivos em `scripts/`, testes, workflow de CI ou configurações do projeto,
  quando o seu pull request for apenas uma correção de transcrição; e
- arquivos de áudio, binários ou conteúdo fora das transcrições.

### Correção com a mesma contagem de palavras

O exemplo abaixo usa o fixture de teste para ser executável sem alterar o
acervo. Ele substitui duas palavras por duas palavras e preserva os timestamps
existentes.

```bash
fixture="$(mktemp -d)"
mkdir -p "$fixture/json"
cp tests/fixtures/tos-007.json "$fixture/json/tos-007.json"
npm run corrigir -- --root "$fixture" --episodio 007 --segmento seg-0001 \
  --esperado 'Primeiro trecho.' --texto 'Outro texto.' --sim
```

Em uma alteração real, troque o caminho do fixture pelo repositório (ou omita
`--root`), use o episódio e o ID de segmento corretos e confira a prévia antes
de confirmar.

### Correção com contagem explícita de palavras

Se você acrescentar, remover ou reposicionar palavras, forneça cada palavra e
seu timestamp em `--palavras-json`. O exemplo seguinte muda duas palavras para
quatro; por isso a ferramenta sinaliza revisão humana obrigatória.

```bash
fixture="$(mktemp -d)"
mkdir -p "$fixture/json"
cp tests/fixtures/tos-007.json "$fixture/json/tos-007.json"
npm run corrigir -- --root "$fixture" --episodio 007 --segmento seg-0001 \
  --esperado 'Primeiro trecho.' --texto 'Primeiro novo trecho corrigido.' \
  --palavras-json '[{"startSeconds":0,"text":"Primeiro"},{"startSeconds":0.4,"text":"novo"},{"startSeconds":1,"text":"trecho"},{"startSeconds":2,"text":"corrigido."}]' \
  --sim
```

Revise manualmente qualquer alteração de **contagem de palavras** ou de
**timestamps**, mesmo quando o comando a aceita. Confirme que cada palavra
continua dentro dos limites do segmento e que os tempos acompanham o áudio.

## Antes de abrir o pull request

Mantenha o pull request pequeno: uma correção ou um grupo curto de correções
com a mesma evidência. Escreva de modo respeitoso sobre pessoas, obras e o
trabalho anterior. Não inclua conteúdo cuja reprodução você não tenha o
direito de enviar; os direitos do material original permanecem com seus
titulares.

Rode estas verificações na raiz do repositório:

```bash
npm test
npm run sync:check
npm run verify
```

No pull request, vincule a issue, liste os episódios modificados, apresente a
evidência e marque a revisão humana de contagem de palavras e timestamps.
