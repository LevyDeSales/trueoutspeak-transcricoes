# True Outspeak — Transcrições

Acervo independente com as **296 transcrições** dos episódios TOS-001 a
TOS-296 do programa True Outspeak. Este repositório contém somente as
transcrições e os arquivos técnicos necessários para organizá-las e
verificá-las — não contém áudio, imagens nem uma cópia do site.

[![Verificação](https://github.com/LevyDeSales/trueoutspeak-transcricoes/actions/workflows/verify.yml/badge.svg)](https://github.com/LevyDeSales/trueoutspeak-transcricoes/actions/workflows/verify.yml)

## Formatos

- [`markdown/`](markdown/): versão legível, separada por episódio e com
  marcações de tempo.
- [`json/`](json/): dados estruturados completos, incluindo texto integral,
  segmentos e marcações por palavra. Os arquivos são cópias byte a byte dos
  dados canônicos do espelho.
- [`indice.json`](indice.json): índice ordenado das 296 transcrições.
- [`MANIFEST.sha256`](MANIFEST.sha256): hashes de integridade dos 592
  arquivos de transcrição.

O conjunto representa aproximadamente **281,55 horas** de gravações
transcritas.

## Acesso rápido

- [Primeira transcrição — TOS-001](markdown/tos-001.md)
- [Última transcrição — TOS-296](markdown/tos-296.md)
- [Índice estruturado completo](indice.json)
- [Repositório de preservação completo, sem áudio](https://github.com/LevyDeSales/trueoutspeak-mirror)

## Proveniência e precisão

Os dados foram separados do projeto
[`trueoutspeak-mirror`](https://github.com/LevyDeSales/trueoutspeak-mirror),
que preserva o conteúdo publicado em `olavão.com.br`. A fonte de transcrição
declarada nos arquivos é `Groq whisper-large-v3`.

Transcrições automáticas podem conter nomes, pontuação ou palavras
incorretas. Consulte as marcações de tempo e os dados estruturados ao revisar
um trecho.

## Verificação

Requer Node.js 22 ou superior:

```bash
npm test
npm run verify
```

A verificação confirma:

- a sequência completa de TOS-001 a TOS-296;
- um JSON e um Markdown não vazio para cada episódio;
- correspondência entre IDs e nomes de arquivo;
- correspondência integral entre cada Markdown, seu JSON e o manifesto
  SHA-256;
- ausência de arquivos de áudio, inclusive por assinatura binária;
- ausência de links simbólicos e de qualquer arquivo fora da allowlist;
- limites seguros de tamanho por arquivo e do repositório completo.

Para regenerar o conjunto a partir de uma cópia local do espelho:

```bash
npm run export -- \
  --source /caminho/para/trueoutspeak-mirror/data/transcricoes \
  --destination .
```

## Direitos

Este repositório não reivindica uma nova licença sobre o conteúdo
transcrito. Os direitos do material original permanecem com seus respectivos
titulares. A organização técnica e os scripts existem para fins de
preservação, consulta e verificação.
