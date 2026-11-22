# Finanças

App pessoal de controle financeiro: contas bancárias, cartões de crédito com faturas mensais, lançamentos e busca. Roda na Cloudflare (Workers + banco D1) e funciona como aplicativo no iPhone e no PC (PWA).

## O que o app faz

- **Contas bancárias**: saldo atual (até hoje), saldo previsto (com lançamentos futuros) e extrato mensal com saldo após cada lançamento.
- **Cartões de crédito**: faturas por mês com status (aberta, fechada, vencida ou paga), limite disponível, compras parceladas (uma parcela por fatura) e pagamento de fatura a partir de uma conta.
- **Lançamentos**: receitas e despesas com categoria, observação e parcelamento.
- **Busca**: por texto, conta, tipo, categoria e período, com totais de entradas e saídas.
- **Transferências** entre contas. Elas não entram como receita nem como despesa.
- **Backup**: exporta todos os dados em JSON (link no rodapé da tela inicial).

Como as faturas funcionam: cada fatura leva o nome do **mês de vencimento**. Uma compra feita **a partir do dia de fechamento** entra na fatura seguinte. Ao lançar, dá para escolher outra fatura manualmente.

## Estrutura

```
src/index.js          API (Cloudflare Worker)
public/               Frontend (HTML/CSS/JS puro, sem build) + PWA
migrations/           Estrutura do banco D1 (SQL)
test/                 Testes da API (Node 22.5+, sem dependências)
wrangler.jsonc        Configuração da Cloudflare
```

## Publicar (passo a passo)

### 1. Enviar para o GitHub
Crie um repositório **privado** e envie estes arquivos:
```bash
git init && git add . && git commit -m "Primeira versão"
git branch -M main
git remote add origin git@github.com:SEU_USUARIO/financas.git
git push -u origin main
```

### 2. Criar o banco D1
No painel da Cloudflare, vá em **Storage & Databases → D1 → Create database** e dê o nome `financas-db`.
Copie o **Database ID** e cole no `wrangler.jsonc`, no lugar de `COLE_AQUI_O_ID_DO_SEU_BANCO_D1`. Depois faça commit e push.

> Pelo terminal também funciona: `npx wrangler login` e depois `npx wrangler d1 create financas-db`.

### 3. Conectar o repositório (deploy automático)
1. Vá em **Workers & Pages → Create → Import a repository**.
2. Autorize o GitHub e escolha o repositório.
3. Configure:
   - **Build command**: deixe em branco
   - **Deploy command**: `npm run deploy`
4. Clique em **Deploy**.

O comando `npm run deploy` cria e atualiza as tabelas do banco (migrations) e publica o app. A partir daí, cada `git push` na `main` publica uma versão nova.

> Se o deploy falhar na etapa de migrations por falta de permissão, rode uma vez no seu PC: `npx wrangler d1 migrations apply DB --remote`. Depois, troque o deploy command para `npx wrangler deploy`. Quando criar uma migration nova no futuro, rode o comando de novo.

O app fica disponível em `https://financas.SEU-SUBDOMINIO.workers.dev`.

### 4. Proteger com login (importante!)
Sem isso, qualquer pessoa com o link vê os seus dados.

1. No painel, abra o Worker `financas` → **Settings → Domains & Routes**. Na linha do `workers.dev`, ative o **Cloudflare Access**.
   (Outro caminho: **Zero Trust → Access → Applications → Add an application → Self-hosted**, com o domínio do app.)
2. Crie uma política **Allow** com **Emails = seu e-mail**. O login é feito por um código enviado ao seu e-mail.
3. **Recomendado**, como segunda camada: a própria API também valida o token do Access. Abra a aplicação em Zero Trust → Access → Applications e copie:
   - o **Application Audience (AUD) Tag**;
   - o seu **team domain** (ex.: `meunome.cloudflareaccess.com`, em Zero Trust → Settings).

   Preencha `ACCESS_AUD` e `ACCESS_TEAM_DOMAIN` em `vars` no `wrangler.jsonc` e faça push. Com essas variáveis preenchidas, a API recusa qualquer chamada que não tenha passado pelo login.

### 5. Instalar no iPhone e no PC
- **iPhone**: abra o endereço no **Safari**, faça login, toque em **Compartilhar → Adicionar à Tela de Início**.
- **PC**: no Chrome ou no Edge, clique no ícone de instalar na barra de endereço (ou use direto no navegador).

## Desenvolvimento local

```bash
npm install
npm run db:migrate:local   # cria o banco local
npm run dev                # http://localhost:8787
npm test                   # testes da API (não precisa de npm install)
```

Se você preencheu as variáveis do Access, crie um arquivo `.dev.vars` com `ACCESS_AUD=""` para desligar a validação no ambiente local.

## Mudanças no banco
Crie um arquivo novo em `migrations/` (ex.: `0002_minha_mudanca.sql`). **Nunca altere migrations já aplicadas.** O próximo deploy aplica o arquivo novo.

## API (resumo)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/summary` | Painel: contas, cartões e totais do mês |
| GET/POST | `/api/accounts` | Listar / criar conta ou cartão |
| PUT/DELETE | `/api/accounts/:id` | Editar / excluir |
| GET | `/api/accounts/:id/statement?month=YYYY-MM` | Extrato mensal |
| GET | `/api/accounts/:id/invoice?invoice=YYYY-MM` | Fatura do cartão |
| GET/POST | `/api/transactions` | Buscar (`q, account_id, type, category, from, to, invoice`) / criar (aceita `installments`) |
| GET/PUT/DELETE | `/api/transactions/:id` | Ver / editar / excluir (`?all=1` exclui todas as parcelas) |
| POST | `/api/transfers` | Transferência ou pagamento de fatura |
| GET | `/api/categories` | Categorias já usadas |
| GET | `/api/export` | Backup completo em JSON |

Os valores são sempre **inteiros em centavos**.
