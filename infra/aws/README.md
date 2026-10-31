# Builders Bot por setor na AWS da Cultura Builder (`bb-srv`)

Infraestrutura como código (CloudFormation + AWS CLI) para rodar **um servidor Builders Bot por setor** (financeiro, marketing…) na conta AWS da Cultura Builder (perfil `cb`, conta `358748433479`, `us-east-1`). Cada pessoa conecta pelo app desktop; no servidor funciona o navegador dos agentes (busca, login em ferramentas, redes sociais).

O desenho completo, com as fontes e as três revisões adversariais, está em `/Users/arielsilva/Projects/openbot-local/.openbot-build/remote-servers/DESIGN.md` (citado aqui como **DESIGN**). Este repositório implementa esse desenho, com os desvios listados na seção [Desvios do DESIGN](#desvios-do-design).

> **Estado:** código pronto e validado só por leitura (`validate-template`, esquemas oficiais via `describe-type`, `shellcheck`). **Nada foi criado na AWS.** Os scripts que criam recursos pedem confirmação digitada e nunca rodaram.

---

## 1. Resumo da arquitetura

| Peça | O quê | Por quê |
|---|---|---|
| **Uma VM EC2 por setor** (`t4g.large` padrão, Graviton arm64) | Um container Builders Bot gerenciado por `docker/instances` do próprio fork | Isolamento de kernel, disco, IP, IAM e custo por setor. A doc do produto pede uma VM por dono sem confiança mútua (docs/docker.md:238-239). Kubernetes ou um host grande com vários containers economizaria ~US$ 4 por setor e perderia esse isolamento (DESIGN 2.3) |
| **Zero portas de entrada** nas VMs de setor | SG `bb-srv-sector` sem regra de entrada; sem SSH; administração só por SSM Session Manager | Regra do dono: sem porta aberta. O servidor só faz conexões de saída (docs/aws-ecs.md:128-133) |
| **VPC nova** `10.60.0.0/24` só com sub-redes públicas e internet gateway | Sem NAT, sem peering, sem endpoint de interface | Não toca a VPC `10.50.0.0/17` nem a default; nenhum NAT por setor |
| **Signal + TURN próprios** (1 VM `t4g.small` compartilhada, stack `bb-srv-signal`) | `remote/compose.yaml` do fork no commit do Worker | Sem eles nenhum setor conecta: `remote/.env.production` do fork ainda aponta para o upstream e o `REMOTE_SIGNAL_URL` do Worker aponta para um stub (`apps/auth-api/wrangler.jsonc:57`, HEAD `bc39bf94d`). É a **única** VM com portas, e elas só abrem com aprovação explícita (`--approve-ingress`) |
| **Subzona `bb-aws.culturabuilder.com` no Route 53** | Nomes `signal.` e `turn.` e o certificado (DNS-01) | O token da Cloudflare recusa este IP (erro 9109). **Uma** ação do dono: 4 registros NS |
| **IAM mínimo** | Role por setor com permissions boundary; SSM sem `AmazonSSMManagedInstanceCore` | Aquela policy lê parâmetros em `*`, e `/hub/prod/*` usa `alias/aws/ssm` (DESIGN 4.5). A role do setor lê só `/bb-srv/sectors/<setor>/*`, puxa só do ECR `bb-srv/server` e escreve só nos próprios log groups |
| **IMDSv2 com hop limit 1**, EBS cifrado, Docker com `userns-remap`, firewall de saída do `docker/instances` | — | Os agentes no container não leem as credenciais da VM nem alcançam faixas privadas |
| **Backups DLM** com pre/post script e retenção por idade | Diário 7 dias, semanal 28 dias | Snapshot consistente do disco de dados (bancos fechados) |

```
App desktop ──HTTPS──► Worker de contas (Cloudflare) ──ticket ES256──┐
     │                                                               ▼
     └──WSS + WebRTC/DTLS──► signal./turn.bb-aws.culturabuilder.com (VM bb-srv-signal, EIP)
                                   │ relay (só se P2P falhar)
VPC bb-srv-vpc 10.60.0.0/24 (IGW, sem NAT)                       ▼
  ├─ bb-srv-financeiro  (t4g.large, SG sem entrada) ── container openbot-financeiro (Chromium/Xvfb, /data)
  ├─ bb-srv-marketing   (mesmo molde, VM separada)
  └─ … um par de stacks por setor
Operador ──SSM Session Manager (documentos bb-srv-*)──► VMs   (sem SSH, sem porta)
```

## 2. Arquivos

| Arquivo | Para quê |
|---|---|
| `templates/base.yaml` → stack `bb-srv-base` | VPC, sub-redes, SGs, ECR `bb-srv/server` (tags imutáveis, scan, delete negado), buckets de log e build, tópico `bb-srv-alerts`, policies e boundaries IAM, roles do scheduler, builder, operador (MFA) e break-glass, launch template do builder, zona Route 53, budget do projeto |
| `templates/ops.yaml` → stack `bb-srv-ops` | Documentos SSM `bb-srv-Install`, `-Upgrade`, `-Down`, `-Status`, `-SnapshotHooks` (o único com `DLMScriptsAccess=true`), role e políticas DLM, alarmes de backup, regras do EventBridge |
| `templates/signal.yaml` → stack `bb-srv-signal` | VM do Signal/TURN, EIP, registros `signal`/`turn`, role com boundary, alarmes. Portas só com `IngressApproved=true` |
| `templates/sector-data.yaml` → stack `bb-srv-<setor>-data` | Só o volume de dados (gp3 cifrado, `DeletionPolicy: Snapshot`) |
| `templates/sector-compute.yaml` → stack `bb-srv-<setor>-compute` | Role e instance profile, VM, anexo do volume, log groups, parâmetros SSM do setor, documentos de sessão (`-Shell`, `-Login`), 7 alarmes, budget, agenda opcional, alerta de sessão fora dos documentos |
| `scripts/check-access.sh` | Para tudo se o perfil não for `cb`, a conta não for `358748433479` ou o IP de saída não estiver em `config/allowed-egress-ips.txt`. Todos os scripts chamam antes de qualquer comando |
| `scripts/deploy-base.sh` | Cria/atualiza `bb-srv-base` e `bb-srv-ops`; mostra os 4 NS para o Cloudflare |
| `scripts/deploy-signal.sh` | Segredos do Signal no SSM (sem exibir), código do commit no bucket, stack `bb-srv-signal` |
| `scripts/build-image.sh` | Constrói a imagem linux/arm64 do fork numa EC2 efêmera e envia ao ECR (ver [Imagem](#6-imagem-do-servidor)) |
| `scripts/add-sector.sh <setor> [tamanho]` | Cria um setor do zero ou a partir de um snapshot |
| `scripts/login-sector.sh` | Login do servidor com a conta dona do setor (sessão SSM `bb-srv-<setor>-Login`) |
| `scripts/upgrade-sector.sh` | Troca a imagem de um setor (pull antes, snapshot pre-upgrade, troca) |
| `scripts/remove-sector.sh <setor>` | Snapshot primeiro, depois apaga as stacks do setor |
| `scripts/status.sh [setor] [--deep]` | Estado de tudo (só leitura) |
| `scripts/validate.sh` | Validação só leitura: `validate-template`, esquemas oficiais, `shellcheck` (também do shell dentro dos templates) |
| `tools/cfn-schema-check.py`, `tools/extract-shell.py` | Usados pelo `validate.sh` (o `cfn-lint` não está instalado neste Mac) |

Nomes: tudo começa com `bb-srv-` (stacks, roles, SGs, documentos, alarmes, budgets, ECR `bb-srv/server`, parâmetros `/bb-srv/...`, log groups `/bb-srv/...`). Tags em tudo: `Project=buildersbot-servers`, `Sector=<setor>` (ou `shared`), `CostCenter=<setor>` (ou `shared`), `Owner=cultura-builder`, `ManagedBy=cloudformation` (as stacks recebem as tags no deploy e os templates repetem as principais).

## 3. Pré-requisitos

- AWS CLI v2 com o perfil `cb`, `session-manager-plugin`, `jq`, `dig`, `openssl`, `git`, `shellcheck` (opcional).
- `config/allowed-egress-ips.txt` com o IP de saída atual (hoje `89.115.7.240`). **Não encontrei condição de IP na IAM da conta `cb`** (`iam list-attached-user-policies`/`list-user-policies` do `ariel` e as policies locais sem `aws:SourceIp`, 31/10/2026); a trava fica no `check-access.sh`.
- **Acesso:** o usuário `ariel` usa chave de longa duração com AdministratorAccess (o `check-access.sh` avisa). Recomendado: sessão temporária com MFA para criar/apagar stacks, e a role `bb-srv-operator` (MFA) para o dia a dia (`status`, `login`, `upgrade`). Exemplo de perfil para a role, em `~/.aws/config`:
  ```ini
  [profile cb-operator]
  source_profile = cb
  role_arn = arn:aws:iam::358748433479:role/bb-srv-operator
  mfa_serial = arn:aws:iam::358748433479:mfa/<dispositivo>
  ```
  (os scripts usam o nome `cb`; para usar a role, aponte o perfil `cb` para ela.)
- O fork em `/Users/arielsilva/Projects/openbot-local` (ou `BB_SRV_FORK=<caminho>`). Os scripts só **leem** o fork (`git archive` de um commit).

## 4. Bloqueios antes do primeiro setor (DESIGN 0.9, atualizados em 31/10/2026)

1. **Build Linux do fork** (DESIGN 7.1): o entrypoint chama `/opt/OpenBot/app/openbot` (`scripts/hosting/openbot-container:97`) e o `electron-builder.yml` não define `linux.executableName` (o pacote se chama `buildersbot`, `package.json:2`). O `build-image.sh` **para com essa causa** se o AppImage não tiver `openbot`. Correção no fork (PR do dev): `linux.executableName: openbot`.
2. **Signal próprio no ar** (passos 4 a 6 abaixo) e o Worker apontando para ele.
3. **Serviço de contas:** no HEAD `bc39bf94d`, `apps/auth-api/wrangler.jsonc:50` está com `AUTH_EXPOSE_DEVELOPMENT_CODE: "false"` (no `c8188b077` do DESIGN estava `"true"`). **O valor publicado não foi verificado** (o deploy usa `--keep-vars`). Antes do piloto: conferir de fora que `/v1/auth/email/start` não devolve o código, e fazer a revogação e a auditoria da DESIGN 4.10 se o flag esteve ligado em produção.
4. **Cota de vCPU** `L-1216C47A`: 64, dividida com o EKS/Karpenter (44 em uso em 31/10 segundo o DESIGN). Os scripts recusam deixar menos de 16 livres. Pedir aumento (ação do dono, passo 1).

## 5. Primeira implantação, em ordem

Cada passo tem verificação e rollback. Não avance sem a verificação do anterior.

| # | Quem | Comando / ação | Verificação | Rollback |
|---|---|---|---|---|
| 0 | Operador | `scripts/check-access.sh` e `scripts/validate.sh` | `acesso ok` e `validação ok` | — |
| 1 | **Dono** | Pedir aumento da cota: `aws --profile cb --region us-east-1 service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A --desired-value 128` | `service-quotas get-service-quota … --quota-code L-1216C47A` mostra 128 | — |
| 2 | Operador | `scripts/deploy-base.sh --alert-email <e-mail>` (cria `bb-srv-base` e `bb-srv-ops`) | `CREATE_COMPLETE` nas duas; o script confere 0 regras de entrada no SG `bb-srv-sector` e 0 NAT na VPC nova | `aws … cloudformation delete-stack --stack-name bb-srv-ops`, depois `bb-srv-base` (ECR e buckets ficam por `Retain`) |
| 3 | **Dono** | **Ação de DNS** (seção 7): 4 registros NS `bb-aws` no Cloudflare | `dig +short NS bb-aws.culturabuilder.com` mostra os 4 `awsdns`; `scripts/status.sh` diz "delegado" | Apagar os 4 NS |
| 4 | **Dono** | Confirmar o e-mail do tópico `bb-srv-alerts`; ativar as tags `Project`, `Sector` e `CostCenter` em Billing → Cost allocation tags | E-mail confirmado; tags ativas (até 24 h) | — |
| 5 | Operador | `scripts/deploy-signal.sh --commit <sha do Worker publicado> --acme-email <e-mail>` (sem portas abertas ainda) | Stack `CREATE_COMPLETE`; em ~20 min o alarme `bb-srv-signal-health` fica OK (o teste local de `/health/ready` e `/health/turn` passa com certificado válido) | `delete-stack bb-srv-signal` (os segredos ficam no SSM) |
| 6 | **Dono aprova** a exceção de portas da VM do Signal (TCP 443, TCP/UDP 3478, TCP 5349, UDP 49152-65535, todas autenticadas); operador roda de novo com `--approve-ingress` | `curl -fsS https://signal.bb-aws.culturabuilder.com/health/turn` responde de fora; teste TURN externo em UDP 3478 | Rodar sem `--approve-ingress` (fecha as portas) |
| 7 | Dev, com OK do dono | Worker de contas: `REMOTE_SIGNAL_URL`, `REMOTE_AUTH_WEBHOOK_URL` e o segredo `REMOTE_AUTH_WEBHOOK_SECRET` (o `deploy-signal.sh` imprime os valores e o comando que passa o segredo sem exibir, rodado em `apps/auth-api` com o wrangler da versão fixada no catálogo do fork, `bunx wrangler@<versão>`) | Um evento de revogação de teste aparece no Signal | Voltar as duas variáveis |
| 8 | Dev | Corrigir o build Linux do fork (bloqueio 1) | — | Reverter o PR |
| 9 | Operador | `scripts/build-image.sh launch <commit>` | Relatório `reports/<versão>-<sha7>-arm64.json` com `smokeTest: passed`; tags `…-arm64` e `…-ops` no ECR | Marcar `"rejected": true` no relatório (o delete de imagem é negado) |
| 10 | Operador | `scripts/add-sector.sh piloto` | `scripts/status.sh piloto --deep`: SSM Online, `openbot-instance list` com `piloto`, `Account: signed out…`, linhas `BB_HEALTH ok` | `scripts/remove-sector.sh piloto` |
| 11 | Operador + caixa da conta dona | `scripts/login-sector.sh piloto bb-piloto@culturabuilder.com "CB Piloto"` (digitar o código do e-mail) | `status.sh piloto --deep` mostra `Account: bb-piloto@…` | `openbot logout` (documento `bb-srv-Down` com `logout=true`) |
| 12 | Operador + Ariel | Convite Admin para o Ariel e conexão (seção 8) | O servidor aparece no app do Ariel; conecta de casa e de 4G | Remover o membro na tela Membros |
| 13 | Ariel | Provedor (chave de API do setor), agentes, papéis (Everyone em `none`/`view`), teste de navegador, busca, login num SaaS, rede social | Ver DESIGN 12, passo 9 | — |
| 14 | Operador | Piloto de backup: esperar o DLM das 07:00 UTC; `status.sh` mostra o último snapshot < 26 h | Snapshot com tag `Sector=piloto` | — |
| 15 | Operador | Setores reais: `scripts/add-sector.sh financeiro`, `scripts/add-sector.sh marketing medium`, … (uma conta dona por setor) | Igual aos passos 10 a 12 | `scripts/remove-sector.sh <setor>` |

Opções úteis do `add-sector.sh`: `--schedule business-hours` (liga 08:00 e desliga 20:00 de seg a sex, BRT; parada de segurança 22:30), `--static-ip` (IP fixo para redes sociais; cota de 5 EIPs, 2 em uso), `--volume-gib 80`, `--budget-usd 120 --budget-email <e-mail>`, `--image-tag <tag>`, `--from-snapshot snap-…`.

## 6. Imagem do servidor

`scripts/build-image.sh launch <commit>` **roda no Mac do operador** e faz:

1. `git archive` do commit do fork → `s3://bb-srv-build-358748433479/src/<sha>.tar.gz`, com o SHA-256 do arquivo na metadata (o hash é sempre o do arquivo gerado no Mac; se o objeto do bucket tiver outro hash, ele é enviado de novo). Envia o próprio script para `tools/` com o hash SHA-256.
2. Liga uma EC2 `t4g.xlarge` efêmera pelo launch template `bb-srv-builder` (Ubuntu 24.04 arm64 resolvido na hora, sem porta de entrada, IMDSv2, disco cifrado, **termina sozinha** em no máximo 3 h). O user data confere o hash do script e roda `build-image.sh on-host` com o hash do tarball.
3. **Na EC2** (Linux arm64 nativo, necessário porque o runtime de voz é preparado para a arquitetura do host, `scripts/prepare-voice.ts:57-58`):
   - o root baixa o tarball, **confere o SHA-256** e extrai, antes de qualquer código do build rodar, uma **cópia intocada** de `docker/`, `package.json` e `.nvmrc`. O usuário `builder` recebe só uma cópia do tarball;
   - Node do `.nvmrc` e Bun do `packageManager` (da cópia intocada) com checksum; `bun install --frozen-lockfile` e `bun run dist:linux:arm64` **como usuário sem privilégio e sem acesso ao IMDS**;
   - o `--appimage-extract` (o runtime do AppImage é saída do build, portanto não confiável) também roda como `builder`; o root só confere o resultado com `test`;
   - fim do código do builder: `crontab -r`, conta travada e vencida (`usermod --lock --expiredate 1`), `loginctl terminate-user` e `pkill` até não sobrar processo. Só então o root usa credenciais;
   - `docker build` com o `Dockerfile` da cópia intocada; teste de fumaça igual ao do release (`.github/workflows/release.yml:949-971`) com o `seccomp.json` da cópia intocada; bundle de operação `FROM scratch` com a pasta `docker/` **da cópia intocada** (tag `…-ops`; é ela que o `bb-srv-Install` roda como root em todo setor); push das duas tags; relatório JSON com os digests e o `sourceSha256` em `reports/`.
4. O Mac espera o relatório e mostra.

Custo: ~US$ 0,13/h × 1-2 h por build **[palpite de duração]**. O `add-sector.sh` e o `upgrade-sector.sh` só aceitam uma tag cujo relatório do builder bate com o ECR: o campo `tag` do relatório é a própria tag, o `opsTag` é `<versão>-<sha7>-ops`, e **as duas tags apontam no ECR para os digests do relatório** (tag imutável e delete negado fixam o par tag→digest; um relatório reescrito para outro digest é recusado). Também recusam imagem rejeitada, sem teste de fumaça ou com CRITICAL no scan da base (o scan não cobre o Electron dentro do AppImage). O bucket de build tem **versionamento**: um relatório sobrescrito deixa a versão anterior (e o autor no CloudTrail). Reconstrua em até 7 dias depois de cada release de segurança do Electron/Chromium e pelo menos 1 vez por mês (DESIGN 4.8). Só arm64 por enquanto; o tamanho `x86` precisa de uma imagem amd64 (builder x86, ainda não automatizado).

Shell no builder (para acompanhar um build), logado em `/bb-srv/builder`: `aws --profile cb --region us-east-1 ssm start-session --target <instância> --document-name bb-srv-builder-Shell`.

## 7. A única ação de DNS do dono

Depois do passo 2, o `deploy-base.sh` imprime os 4 name servers da zona `bb-aws.culturabuilder.com`. No painel da Cloudflare:

1. Conta da Cultura Builder → zona **culturabuilder.com** → **DNS** → **Records** → **Add record**.
2. Tipo **NS**, Nome **`bb-aws`**, Nameserver = o 1º name server (ex.: `ns-123.awsdns-45.com`), TTL **Auto**. Salvar. (Registro NS não tem proxy.)
3. Repetir para o 2º, o 3º e o 4º, sempre com o nome `bb-aws`.
4. Conferir: `dig +short NS bb-aws.culturabuilder.com` (4 `awsdns`) e `dig +short SOA bb-aws.culturabuilder.com` (`awsdns-hostmaster.amazon.com`).

Rollback: apagar os 4 registros (o Signal perde o nome e ninguém conecta). O domínio não tem DNSSEC nem CAA (DESIGN 6.3), então a delegação não precisa de `DS` e o Let's Encrypt pode emitir.

## 8. Como conectar pelo app desktop

**Ajuste de expectativa:** o app **não tem campo de URL ou IP** para "adicionar servidor remoto". Um servidor self-hosted aparece sozinho para a conta que fez o login nele (a conta dona do setor); as outras pessoas entram por **link de convite** (docs/self-hosted-server.md:20-23; DESIGN 1).

**Uma vez por setor (operador):**
1. `scripts/login-sector.sh <setor> bb-<setor>@culturabuilder.com "CB <Setor>"` → digitar o código que chega na caixa da conta dona.
2. Num **perfil separado** do Builders Bot (outro usuário do macOS), entrar com a conta dona: o servidor "CB <Setor>" aparece. **Configurações do servidor → Membros → Convidar pessoas → Link de convite** (uso único, 24 h), função **Admin**, copiar e mandar ao Ariel por canal privado. Sair da conta dona nesse perfil.

**Ariel (e cada membro):**
1. Abrir o Builders Bot com a **conta pessoal** (Cultura Builder ou código por e-mail).
2. Botão **+** da barra de servidores → **Entrar em um servidor** → colar em **Link de convite** → **Revisar convite** → ver **Convite verificado** e **Computador anfitrião verificado** → **Conectar** (packages/i18n/src/messages/pt/server.ts:61-75, 110). **Colar o link, não clicar** (DESIGN 11.4).
3. Na primeira vez: **Configurações do servidor → Provedores** → chave de API do setor; criar os agentes; **Papéis** com Everyone em `none` ou `view`.

**Regras:** uma conta dona por setor, nunca reutilizada; a conta pessoal do Ariel nunca faz login num servidor (a sessão do dono fica no `/data`, que os agentes leem: DESIGN 3.3). Só link de uso único (a aba E-mail falha no fork; não usar "Link permanente"). Sem licença, cada servidor aceita 3 membros ativos com o dono (`packages/contracts/src/input-limits.ts:134-137`): para mais, uma linha `server_member_limits` no D1 `buildersbot-auth` (DESIGN 3.3). Membro com `chat` em qualquer agente vê todos os dados e logins do setor: sigilo forte = outro setor.

**Navegador no servidor:** o `bb-srv-Install` grava `browserInApp: true` (sem isso os agentes usam Playwright no computador da pessoa, DESIGN 5). Login em SaaS: `browser-sign-in-v1` (só no app desktop) ou takeover no live view. Redes sociais podem pedir CAPTCHA em IP de datacenter: setor 24/7 ou `--static-ip`.

## 9. Custo estimado (US$/mês, us-east-1, On-Demand)

Preços conferidos na Pricing API em 31/10/2026: `t4g.small` 0,0168/h, `t4g.medium` 0,0336/h, `t4g.large` 0,0672/h, gp3 0,08/GB-mês; os demais itens vêm do DESIGN 9.1 (mesma fonte). Volumes de log, snapshot e saída são **[palpite]**.

**Por setor `t4g.large` 24/7 ≈ US$ 62,74:** EC2 49,06 + EBS 60 GB 4,80 + snapshots ~20 GB 1,00 + IPv4 3,65 + logs ~1 GB 0,53 + saída ~20 GB 1,80 + 7 alarmes 0,70 + 4 métricas custom 1,20 (`Healthy`, `mem_used_percent`, `disk_used_percent` do `/data` e do `/`).
`t4g.medium` 24/7 ≈ **38,21**. `t4g.large` em horário comercial (264 h) ≈ **28,86**. Com live view intenso (~150 GB de saída) ≈ 74,44.

**Fixo compartilhado ≈ US$ 23,01:** Signal/TURN 18,31 (EC2 12,26 + IPv4 3,65 + EBS 1,60 + logs 0,30 + alarmes/métrica 0,50), zona Route 53 0,50, ECR ~2,00, ~4 builds 1,20, Flow Logs ~0,50, 5 alarmes da base/backup 0,50. Budgets, EventBridge, SQS e e-mail do SNS ≈ 0. Mais o relay TURN a US$ 0,09/GB.

| Cenário | 1 setor | 5 setores | 20 setores |
|---|---|---|---|
| Todos `t4g.large` 24/7 | **85,75** | **336,71** | **1.277,81** |
| Mix com 20 (6 large 24/7 + 8 medium 24/7 + 6 large horário comercial) | — | — | **878,29** |
| `t4g.large` 24/7 com Savings Plan Compute 1 ano (0,0485/h) | 72,10 | 268,46 | 1.004,81 |

Fórmula: N × custo por setor + 23,01. Com 20 setores o Signal provavelmente precisa de `t4g.medium` (+~12) **[palpite]**. Fora desta conta: o uso dos provedores de IA, em geral o maior custo. Contexto: o budget da conta é US$ 400 e o gasto de outubro passou de US$ 2.500 (DESIGN 9.3); quantos setores ligar é decisão do dono. Cada setor tem um budget próprio (padrão US$ 80) e o projeto um budget total (padrão US$ 150), que dependem das tags de custo ativas.

## 10. Operação

- **Estado:** `scripts/status.sh` (tudo) e `scripts/status.sh <setor> --deep` (estado do host por `bb-srv-Status`).
- **Shell de administração** (logado em `/bb-srv/<setor>/ssm-sessions`): `aws --profile cb --region us-east-1 ssm start-session --target <instância> --document-name bb-srv-<setor>-Shell`. Uma sessão sem documento ou com outro documento gera alerta (regras `bb-srv-<setor>-session-*`).
- **Atualizar imagem:** `scripts/upgrade-sector.sh <setor> <tag>`; primeiro num setor canário, 24 h, depois os outros. Nunca voltar para imagem mais antiga sobre o mesmo `/data`.
- **Backups:** automáticos (DLM). Setores 24/7: 07:00 UTC com pre/post script (~1-2 min fora do ar entre 04:00 e 05:00 BRT) e semanal domingo 04:00 UTC. Setores em horário comercial: 02:00 UTC com a VM parada. Reboot de patches do SO às 09:30 UTC.
- **Logs:** `/bb-srv/<setor>` (container, saúde, bootstrap; 30 dias), `/bb-srv/<setor>/ssm-sessions` (90 dias), Flow Logs da VPC em `s3://bb-srv-logs-358748433479/flow/` (90 dias). CloudTrail da conta é o registro confiável.
- **Alertas:** tudo no tópico `bb-srv-alerts`.

## 11. Rollback e recuperação

| Situação | O que fazer |
|---|---|
| Uma stack falhou na criação | O script mostra os eventos. A stack fica em `ROLLBACK_COMPLETE`: `aws --profile cb --region us-east-1 cloudformation delete-stack --stack-name <stack>` e rodar de novo |
| Desfazer um setor | `scripts/remove-sector.sh <setor>` (snapshot completo **antes** de apagar; grava o id em `/bb-srv/sectors/<setor>/final-snapshot`, retido 180 dias). Antes do snapshot, o logout da conta dona: com a VM parada (horário comercial), o script liga a VM para isso; se o `bb-srv-Down` não confirmar o logout (`BB_LOGOUT ok`), só segue com a confirmação digitada `sessao-no-snapshot` (a sessão fica no snapshot e volta numa restauração) |
| Recriar um setor removido | `scripts/add-sector.sh <setor> --from-snapshot <snap>` (mesma identidade, agentes e conversas; novo login). Recusa snapshot de outro setor |
| Upgrade deu errado | Restaurar o snapshot `pre-upgrade` **com a imagem anterior** (tag `PreviousImage` do snapshot): `scripts/remove-sector.sh <setor> --keep-registration` (sem remover no app e sem logout), depois `scripts/add-sector.sh <setor> --from-snapshot <snap-pre-upgrade>`. O modo attach roda a imagem gravada no `.env` do disco restaurado, que é a anterior (só `bb-srv/server` por digest; outra origem é recusada), e o `add-sector.sh` grava em `/bb-srv/sectors/<setor>/image` a imagem que o `bb-srv-Install` informou (linha `BB_IMAGE`), não a do relatório mais novo. `--image-tag` aqui só escolhe o bundle de operação. Nunca rode a imagem nova sobre o disco antigo nem duas cópias do mesmo snapshot |
| VM com defeito (disco bom) ou trocar a AMI | 1) `aws --profile cb --region us-east-1 ec2 stop-instances --instance-ids <i>` e esperar `stopped`; 2) `aws … ec2 modify-instance-attribute --instance-id <i> --no-disable-api-termination`; 3) `aws … cloudformation delete-stack --stack-name bb-srv-<setor>-compute` (o volume fica na stack `-data` e volta a `available`); 4) `scripts/add-sector.sh <setor> <tamanho> --reattach` (VM nova na zona do volume, AMI atual, `bb-srv-Install` em modo `attach` com a imagem gravada no disco). Antes, se quiser, um snapshot: `aws … ec2 create-snapshot --volume-id <vol>` |
| Atualizar o Signal para outro commit | `delete-stack bb-srv-signal` e `deploy-signal.sh` com o commit novo (o user data só roda no primeiro boot). O EIP muda e os registros DNS acompanham (TTL 300); conexões novas param ~20 min |
| Desligar a exposição do Signal | `deploy-signal.sh … ` sem `--approve-ingress` |
| Desfazer tudo | Remover os setores; `delete-stack` de `bb-srv-signal`, `bb-srv-ops`, `bb-srv-base`; apagar os 4 NS no Cloudflare. Ficam por `Retain`: o ECR `bb-srv/server`, os buckets `bb-srv-build-*` e `bb-srv-logs-*` e os parâmetros `/bb-srv/signal/*` (apagar à mão, conscientemente) |

Toda atualização de stack de setor passa por change set, e o script **recusa** executar um change set que substitua ou remova instância, volume ou anexo (DESIGN R2-1).

## 12. Segurança (resumo)

OWASP/regras do dono: nenhuma porta de entrada nas VMs de setor; nenhuma API sem autenticação (a Team API escuta em `127.0.0.1` e os dados vão por WebRTC/DTLS com ticket ES256 validado pelo host, DESIGN 4.2); nenhum segredo em arquivo versionado, user data, imagem, parâmetro de stack ou saída de script (segredos do Signal guardados só em SSM SecureString, gerados por `openssl` e passados pela entrada padrão). **Limite conhecido:** na VM do Signal, o `remote/compose.yaml` do fork entrega os 4 segredos aos containers como **variáveis de ambiente**: eles aparecem em `docker inspect` (só root) e ficam em `/var/lib/docker/containers/*/config.v2.json`, no disco raiz cifrado da VM; o arquivo de ambiente do compose fica num tmpfs (`/run/bb-srv-signal`, 0600). Quem é root na VM do Signal lê os segredos. CORS não se aplica (não há API HTTP exposta pelos setores; o Signal só aceita WSS com ticket). **A exceção:** a VM do Signal/TURN abre portas autenticadas, só com `--approve-ingress`, e o coturn nega peers privados (`remote/coturn/turnserver.conf`). GuardDuty está desligado na conta (DESIGN 4.9): ligar é recomendação ao dono.

## 13. Licença do produto

O Builders Bot é **PolyForm Noncommercial 1.0.0** (`package.json:11`; AGENTS.md do fork). O uso pelos setores de uma empresa é uso comercial e exige licença comercial do titular do copyright. **Assunto do dono; esta infraestrutura não resolve isso.**

## 14. Desvios do DESIGN

| DESIGN | Aqui | Motivo |
|---|---|---|
| Nomes `buildersbot-*`, `bb-sector-*`, `BuildersBot-*`; tag `Project=buildersbot` | Prefixo único `bb-srv-`; `Project=buildersbot-servers`, `Owner`, `CostCenter` | Pedido desta tarefa |
| Documentos e DLM na stack base | Stack separada `bb-srv-ops` | O DLM referencia o documento de hooks; e cada template fica abaixo de 51.200 bytes (limite de `--template-body`) |
| Role de serviço `bb-cfn-exec` | Não criada | Uma role de serviço mínima para EC2+IAM+SSM+Scheduler+Budgets é extensa e não testável sem criar recursos. O boundary `bb-srv-host-boundary` fica em toda role de setor. Próximo passo |
| Trust da role do host com `aws:SourceAccount` | Sem a condição | Se a EC2 não enviar a chave, a VM fica sem credenciais (DESIGN marcou "[validar]"); a proteção real é o `iam:PassRole` |
| (não especificado) | Trust da role `bb-srv-dlm` sem condição; tópico aceita EventBridge só de regras `bb-srv-*` (`aws:SourceArn`) | Uma condição que o DLM não envie pararia todos os backups em silêncio |
| Host sem nenhuma leitura de parâmetro | Lê só `/bb-srv/sectors/<setor>/*` (config do CloudWatch agent); `Deny` explícito no resto, também para `kms:Decrypt` fora desse caminho | Pedido desta tarefa ("read of its own SSM parameters"); mantém a garantia da DESIGN 4.5 para `/hub/prod/*` |
| Sem parâmetro de imagem na stack | `ImageTag` na stack só grava `/bb-srv/sectors/<setor>/image-tag`; a imagem real vai por digest no `bb-srv-Install`/`-Upgrade` | Pedido desta tarefa, sem reintroduzir o drift de R2-1 |
| `lego` no host por timer | O serviço `acme` do próprio compose com `--dns route53` (override, rede do host) | Menos peças; o compose continua o do fork |
| `TURN_PUBLIC_IP=<EIP>` | `<EIP>/<IP privado>` lido do IMDS a cada start | O coturn atrás do NAT 1:1 da EC2 precisa do mapeamento (`external-ip=público/privado`); o entrypoint aceita o valor como está **[inferência; validar no piloto]** |
| `--idle-stop`, `resize`, `grow`, `restore-check`, `gc`, `backups` | Não implementados (`replace`/`rebase` = `add-sector.sh --reattach`) | Escopo. `status.sh` mostra a idade do último snapshot (> 26 h = atrasado). Mudar o tamanho exige também trocar `OPENBOT_MEM` no `.env` do disco (DESIGN 2.6): faça com `--reattach` e o tamanho novo só depois de ajustar o `.env` pela sessão `bb-srv-<setor>-Shell` |
| Builder x86 | Só arm64 | Escopo |

## 15. Não verificado (validar no piloto)

- Nada rodou na AWS: os templates passaram em `validate-template` e na checagem de esquema, mas a criação real pode achar erros de semântica (por exemplo IAM, DLM com scripts, agendas).
- Ubuntu 24.04 + AppArmor + user namespaces no container (docs/docker.md:510-513). Plano B: perfil AppArmor próprio (DESIGN 4.6).
- O build Linux do fork e o nome do executável (bloqueio 1).
- O padrão do evento `StartSession` (campos `target` e `documentName`) nas regras de alerta de sessão.
- As dimensões exatas das métricas do CloudWatch agent (`path`, `fstype=ext4`, `Sector`) usadas no alarme de disco.
- O nome da unidade do SSM agent (snap) para o `OOMScoreAdjust`; o pacote `docker-buildx` no Ubuntu 24.04 do Signal.
- O mapeamento `external-ip` do coturn e o certificado com `lego --dns route53` pela role da VM.
- Se as sessões `InteractiveCommands` (`-Login`) também vão para o log de sessão.
- Os números de custo marcados como palpite (logs, saída, snapshots, duração do build).
