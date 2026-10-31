# Builders Bot por setor na AWS da Cultura Builder (`bb-srv`)

Infraestrutura como código (CloudFormation + AWS CLI) para rodar **um servidor Builders Bot por setor** (financeiro, marketing…) na conta AWS da Cultura Builder (perfil `cb`, conta `358748433479`, `us-east-1`). Cada pessoa conecta pelo app desktop; no servidor funciona o navegador dos agentes (busca, login em ferramentas, redes sociais).

O desenho completo, com as fontes e as três revisões adversariais, está em `/Users/arielsilva/Projects/openbot-local/.openbot-build/remote-servers/DESIGN.md` (citado aqui como **DESIGN**). Este repositório implementa esse desenho, com os desvios listados na seção [Desvios do DESIGN](#desvios-do-design).

> **Estado:** código pronto e validado só por leitura (`validate-template`, esquemas oficiais via `describe-type`, `shellcheck`, `bash -n`) e por testes negativos contra um `aws` falso que recusa qualquer escrita (`tests/negative.sh`). **Nada foi criado na AWS.** Os scripts que criam recursos pedem confirmação digitada, exigem sessão temporária com MFA e nunca rodaram.

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
| `templates/dns.yaml` → stack `bb-srv-dns` | Só a zona Route 53 `bb-aws.culturabuilder.com` (retida no delete e na substituição; apagada só se a própria criação falhar). Fica de pé quando a base é apagada ou refeita, então os 4 NS do Cloudflare não mudam |
| `templates/base.yaml` → stack `bb-srv-base` | VPC, sub-redes (zonas fixas `us-east-1a`/`b`), SGs, ECR `bb-srv/server` (tags imutáveis, scan, delete de imagem negado), buckets de log e build (o de build com versionamento), tópico `bb-srv-alerts`, policies e boundaries IAM, roles do scheduler, builder, operador (MFA) e break-glass, launch template do builder, documento `bb-srv-builder-Shell`, budget do projeto |
| `templates/ops.yaml` → stack `bb-srv-ops` | Documentos SSM `bb-srv-Install`, `-Upgrade`, `-Down`, `-Status`, `-SnapshotHooks` (o único com `DLMScriptsAccess=true`), role DLM (policy própria: só o documento de hooks e só instâncias `Project=buildersbot-servers`) e políticas DLM, alarmes de backup, regras do EventBridge |
| `templates/signal.yaml` → stack `bb-srv-signal` | VM do Signal/TURN, EIP, registros `signal`/`turn`, role com boundary, alarmes, documento de shell logado `bb-srv-signal-Shell` e alertas de sessão. Portas só com `IngressApproved=true` |
| `templates/sector-data.yaml` → stack `bb-srv-<setor>-data` | Só o volume de dados (gp3 cifrado, `DeletionPolicy: Snapshot`) |
| `templates/sector-compute.yaml` → stack `bb-srv-<setor>-compute` | Role e instance profile, VM (criada **sem** proteção contra término; o `add-sector.sh` liga a proteção depois do `bb-srv-Install`), anexo do volume, log groups, parâmetros SSM do setor, documentos de sessão (`-Shell`, `-Login`), 7 alarmes, budget, agenda opcional, alerta de sessão fora dos documentos |
| `scripts/check-access.sh [--writes]` | Para tudo se o perfil não for `cb`, a conta não for `358748433479` ou o IP de saída não estiver em `config/allowed-egress-ips.txt`. Com `--writes` (todo script que altera a AWS) recusa chave de longa duração de usuário IAM (salvo `BB_SRV_ALLOW_LONG_TERM_KEY=1`) e sempre a do root. Todos os scripts chamam antes de qualquer comando |
| `scripts/deploy-base.sh` | Cria/atualiza `bb-srv-dns`, `bb-srv-base` e `bb-srv-ops`, nessa ordem; recusa criar a base sobre sobras; mostra os 4 NS para o Cloudflare |
| `scripts/deploy-signal.sh` | Segredos do Signal no SSM (sem exibir), código do commit no bucket, stack `bb-srv-signal` |
| `scripts/build-image.sh` | Constrói a imagem linux/arm64 do fork numa EC2 efêmera e envia ao ECR (ver [Imagem](#6-imagem-do-servidor)) |
| `scripts/add-sector.sh <setor> [tamanho]` | Cria um setor do zero ou a partir de um snapshot |
| `scripts/login-sector.sh` | Login do servidor com a conta dona do setor (sessão SSM `bb-srv-<setor>-Login`) |
| `scripts/upgrade-sector.sh` | Troca a imagem de um setor (pull antes, snapshot pre-upgrade, troca) |
| `scripts/remove-sector.sh <setor>` | Snapshot primeiro, depois apaga as stacks do setor e ajusta o budget do projeto |
| `scripts/gc-snapshots.sh [--delete]` | Lista (padrão) ou apaga, com confirmação digitada, os snapshots com `ExpiresAt` vencido e os do DLM de setores removidos com mais de 28 dias |
| `scripts/status.sh [setor] [--deep]` | Estado de tudo (só leitura) |
| `scripts/validate.sh` | Validação só leitura: `validate-template`, esquemas oficiais, `shellcheck` e `bash -n` (também do shell dentro dos templates) e `tests/negative.sh` |
| `tests/negative.sh`, `tests/fake-bin/` | Os caminhos de recusa dos scripts contra um `aws` falso que responde às leituras do cenário e recusa qualquer escrita (não toca a AWS) |
| `tools/cfn-schema-check.py`, `tools/extract-shell.py` | Usados pelo `validate.sh` (o `cfn-lint` não está instalado neste Mac) |

Nomes: tudo começa com `bb-srv-` (stacks, roles, SGs, documentos, alarmes, budgets, ECR `bb-srv/server`, parâmetros `/bb-srv/...`, log groups `/bb-srv/...`). Tags em tudo: `Project=buildersbot-servers`, `Sector=<setor>` (ou `shared`), `CostCenter=<setor>` (ou `shared`), `Owner=cultura-builder`, `ManagedBy=cloudformation` (as stacks recebem as tags no deploy e os templates repetem as principais).

## 3. Pré-requisitos

- AWS CLI v2 com o perfil `cb`, `session-manager-plugin`, `jq`, `dig`, `openssl`, `git`, `shellcheck` (opcional).
- `config/allowed-egress-ips.txt` com o IP de saída atual (hoje `89.115.7.240`). **Não encontrei condição de IP na IAM da conta `cb`** (`iam list-attached-user-policies`/`list-user-policies` do `ariel` e as policies locais sem `aws:SourceIp`, 31/10/2026); a trava fica no `check-access.sh`.
- **Acesso (sessão temporária com MFA).** Todo script que altera a AWS (todos menos `status.sh` e `validate.sh`) **recusa a chave de longa duração** do usuário `ariel` (AdministratorAccess) e mostra como abrir a sessão. O caminho: a role `culturabuilder-admin`, que **já existe** na conta (AdministratorAccess, confia na conta só com `aws:MultiFactorAuthPresent`, sessão de até 4 h; conferido por leitura em 31/10/2026). Ação do dono, uma vez:
  1. em `~/.aws/credentials`, renomear o perfil `[cb]` (a chave) para `[cb-chave]`;
  2. em `~/.aws/config`:
     ```ini
     [profile cb]
     source_profile = cb-chave
     role_arn = arn:aws:iam::358748433479:role/culturabuilder-admin
     mfa_serial = arn:aws:iam::358748433479:mfa/cb-ariel-local-20261020
     duration_seconds = 14400
     region = us-east-1
     ```
  3. `scripts/check-access.sh --writes` pede o código MFA uma vez e mostra `credencial temporary`. O AWS CLI guarda a sessão até ela vencer (4 h cobrem o build mais longo, que espera até 3,5 h).
  Uma sessão do próprio usuário com MFA (`sts get-session-token`, chave `ASIA…`) também é aceita. **`BB_SRV_ALLOW_LONG_TERM_KEY=1`** antes do comando aceita a chave de longa duração, com aviso; use só se não houver outro jeito e conscientemente. A chave do root é sempre recusada. O `check-access.sh` sem `--writes`, o `status.sh` e o `validate.sh` só avisam.
- **Dia a dia com a role `bb-srv-operator`** (MFA; `status`, `login`, `upgrade`, sem criar ou apagar stack). Exemplo, também com a chave em `cb-chave` (não use `source_profile = cb`, que já é uma role: encadear roles limita a sessão a 1 h):
  ```ini
  [profile cb-operator]
  source_profile = cb-chave
  role_arn = arn:aws:iam::358748433479:role/bb-srv-operator
  mfa_serial = arn:aws:iam::358748433479:mfa/cb-ariel-local-20261020
  ```
  (os scripts usam o nome `cb`; para usar essa role, aponte o perfil `cb` para ela.)
- **Role de serviço do CloudFormation (`bb-cfn-exec`):** não criada (opcional, decisão do dono). As stacks rodam com a sessão MFA de quem as aplica; ver [Desvios](#14-desvios-do-design).
- O fork em `/Users/arielsilva/Projects/openbot-local` (ou `BB_SRV_FORK=<caminho>`). Os scripts só **leem** o fork (`git archive` de um commit).

## 4. Bloqueios antes do primeiro setor (DESIGN 0.9, atualizados em 31/10/2026)

1. **Build Linux do fork** (DESIGN 7.1): o entrypoint chama `/opt/OpenBot/app/openbot` (`scripts/hosting/openbot-container:97`) e o `electron-builder.yml` não define `linux.executableName` (o pacote se chama `buildersbot`, `package.json:2`). O `build-image.sh` **para com essa causa** se o AppImage não tiver `openbot`. Correção no fork (PR do dev): `linux.executableName: openbot`.
2. **Signal próprio no ar** (passos 4 a 6 abaixo) e o Worker apontando para ele.
3. **Serviço de contas:** no HEAD `bc39bf94d`, `apps/auth-api/wrangler.jsonc:50` está com `AUTH_EXPOSE_DEVELOPMENT_CODE: "false"` (no `c8188b077` do DESIGN estava `"true"`). **O valor publicado não foi verificado** (o deploy usa `--keep-vars`). Antes do piloto: conferir de fora que `/v1/auth/email/start` não devolve o código, e fazer a revogação e a auditoria da DESIGN 4.10 se o flag esteve ligado em produção.
4. **Cota de vCPU** `L-1216C47A`: 64, dividida com o EKS/Karpenter (44 em uso em 31/10 segundo o DESIGN). Os scripts recusam deixar menos de 16 livres. Pedir aumento (ação do dono, passo 1).
5. **Cota de Elastic IP** `L-0263D0A3`: 5, com 2 em uso na conta (um é do NAT da VPC `10.50.0.0/17`). O Signal usa 1 e cada `--static-ip` mais 1; o `deploy-signal.sh` e o `add-sector.sh --static-ip` recusam deixar menos de 1 livre para a conta (`BB_SRV_EIP_RESERVE`). Com mais de um setor de IP fixo, pedir aumento da cota.

## 5. Primeira implantação, em ordem

Cada passo tem verificação e rollback. Não avance sem a verificação do anterior.

| # | Quem | Comando / ação | Verificação | Rollback |
|---|---|---|---|---|
| 0 | **Dono** + operador | Perfil `cb` com MFA (seção 3); `scripts/check-access.sh --writes` e `scripts/validate.sh` | `acesso ok … credencial temporary` e `validação ok` | — |
| 1 | **Dono** | Pedir aumento da cota: `aws --profile cb --region us-east-1 service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A --desired-value 128` | `service-quotas get-service-quota … --quota-code L-1216C47A` mostra 128 | — |
| 2 | Operador | `scripts/deploy-base.sh --alert-email <e-mail>` (cria `bb-srv-dns`, `bb-srv-base` e `bb-srv-ops`, nessa ordem; antes de escrever, recusa sobras de uma base anterior) | `CREATE_COMPLETE` nas três; o script confere 0 regras de entrada no SG `bb-srv-sector` e 0 NAT na VPC nova | Uma criação que falha se desfaz sozinha, inclusive os buckets e o ECR (`RetainExceptOnCreate`). Depois de criadas: `aws … cloudformation delete-stack --stack-name bb-srv-ops`, depois `bb-srv-base` (ECR e buckets com dados ficam; ver "Sobras da base" na seção 11). **Nunca** apague `bb-srv-dns` num rollback: os 4 NS continuam valendo |
| 3 | **Dono** | **Ação de DNS** (seção 7): 4 registros NS `bb-aws` no Cloudflare | `dig +short NS bb-aws.culturabuilder.com` mostra os 4 `awsdns`; `scripts/status.sh` diz "delegado ao Route 53 (os 4 NS da zona bb-srv-dns)" | Apagar os 4 NS |
| 4 | **Dono** | Confirmar o e-mail do tópico `bb-srv-alerts`; ativar as tags `Project`, `Sector` e `CostCenter` em Billing → Cost allocation tags | E-mail confirmado; tags ativas (até 24 h) | — |
| 5 | Operador | `scripts/deploy-signal.sh --commit <sha do Worker publicado> --acme-email <e-mail>` (sem portas abertas ainda) | Stack `CREATE_COMPLETE`; em ~20 min o alarme `bb-srv-signal-health` fica OK (o teste local de `/health/ready` e `/health/turn` passa com certificado válido) | `delete-stack bb-srv-signal` (os segredos ficam no SSM) |
| 6 | **Dono aprova** a exceção de portas da VM do Signal (TCP 443, TCP/UDP 3478, TCP 5349, UDP 49152-65535, todas autenticadas); operador roda `scripts/deploy-signal.sh --approve-ingress` (atualização: a AMI, o commit, o hash do código e o e-mail ACME ficam os da criação) | `curl -fsS https://signal.bb-aws.culturabuilder.com/health/turn` responde de fora; teste TURN externo em UDP 3478 | `scripts/deploy-signal.sh` sem `--approve-ingress` (fecha as portas; não resolve AMI, não confere cota nem DNS, então sempre funciona) |
| 7 | Dev, com OK do dono | Worker de contas: `REMOTE_SIGNAL_URL`, `REMOTE_AUTH_WEBHOOK_URL` e o segredo `REMOTE_AUTH_WEBHOOK_SECRET` (o `deploy-signal.sh` imprime os valores e o comando que passa o segredo sem exibir, rodado em `apps/auth-api` com o wrangler da versão fixada no catálogo do fork, `bunx wrangler@<versão>`) | Um evento de revogação de teste aparece no Signal | Voltar as duas variáveis |
| 8 | Dev | Corrigir o build Linux do fork (bloqueio 1) | — | Reverter o PR |
| 9 | Operador | `scripts/build-image.sh launch <commit>` | Relatório `reports/<versão>-<sha7>-arm64.json` com `smokeTest: passed`; tags `…-arm64` e `…-ops` no ECR | Marcar `"rejected": true` no relatório (o delete de imagem é negado) |
| 10 | Operador | **Setor piloto** (decisão do dono: nome `piloto`, tamanho `large`): `scripts/add-sector.sh piloto large` | `scripts/status.sh piloto --deep`: SSM Online, `openbot-instance list` com `piloto`, `Account: signed out…`, linhas `BB_HEALTH ok`, `proteção contra término: true` | Instalação falhou com a stack criada: `scripts/add-sector.sh piloto --resume`. Desfazer: `scripts/remove-sector.sh piloto` |
| 11 | Operador + caixa da conta dona | `scripts/login-sector.sh piloto bb-piloto@culturabuilder.com "CB Piloto"` (digitar o código do e-mail) | `status.sh piloto --deep` mostra `Account: bb-piloto@…` | `openbot logout` (documento `bb-srv-Down` com `logout=true`) |
| 12 | Operador + Ariel | Convite Admin para o Ariel e conexão (seção 8) | O servidor aparece no app do Ariel; conecta de casa e de 4G | Remover o membro na tela Membros |
| 13 | Ariel | Provedor (chave de API do setor), agentes, papéis (Everyone em `none`/`view`), teste de navegador, busca, login num SaaS, rede social | Ver DESIGN 12, passo 9 | — |
| 14 | Operador | Piloto de backup: esperar o DLM das 07:00 UTC; `status.sh` mostra o último snapshot < 26 h | Snapshot com tag `Sector=piloto` | — |
| 15 | Operador | Setores reais: `scripts/add-sector.sh financeiro`, `scripts/add-sector.sh marketing medium`, … (uma conta dona por setor). Cada `add-sector`/`remove-sector` ajusta o budget do projeto | Igual aos passos 10 a 12 | `scripts/remove-sector.sh <setor>` |

Opções úteis do `add-sector.sh`: `--schedule business-hours` (liga 08:00 e desliga 20:00 de seg a sex, BRT; parada de segurança 22:30), `--static-ip` (IP fixo para redes sociais; a cota de EIP é conferida, bloqueio 5), `--volume-gib 80`, `--budget-usd 120 --budget-email <e-mail>` (sem `--budget-usd`, o padrão segue o tamanho: medium 50, large 80, steady 95, x86 90, xlarge 140), `--image-tag <tag>`, `--from-snapshot snap-…`, `--resume`.

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

Depois do passo 2, o `deploy-base.sh` imprime os 4 name servers da zona `bb-aws.culturabuilder.com` (stack `bb-srv-dns`, que nenhum rollback da base apaga: os NS não mudam). No painel da Cloudflare:

1. Conta da Cultura Builder → zona **culturabuilder.com** → **DNS** → **Records** → **Add record**.
2. Tipo **NS**, Nome **`bb-aws`**, Nameserver = o 1º name server (ex.: `ns-123.awsdns-45.com`), TTL **Auto**. Salvar. (Registro NS não tem proxy.)
3. Repetir para o 2º, o 3º e o 4º, sempre com o nome `bb-aws`.
4. Conferir: `dig +short NS bb-aws.culturabuilder.com` (4 `awsdns`) e `dig +short SOA bb-aws.culturabuilder.com` (`awsdns-hostmaster.amazon.com`).

Rollback: apagar os 4 registros (o Signal perde o nome e ninguém conecta). O domínio não tem DNSSEC nem CAA (DESIGN 6.3), então a delegação não precisa de `DS` e o Let's Encrypt pode emitir. **Se a zona um dia for apagada e criada de novo, ela vem com outros 4 NS:** é preciso refazer os registros (o `status.sh` avisa "delegado a OUTROS name servers"). E nunca apague a zona antes de tirar os NS do Cloudflare (seção 11, "Desfazer tudo").

## 8. Como conectar pelo app desktop

**Ajuste de expectativa:** o app **não tem campo de URL ou IP** para "adicionar servidor remoto". Um servidor self-hosted aparece sozinho para a conta que fez o login nele (a conta dona do setor); as outras pessoas entram por **link de convite** (docs/self-hosted-server.md:20-23; DESIGN 1).

**Uma vez por setor (operador):**
1. `scripts/login-sector.sh <setor> bb-<setor>@culturabuilder.com "CB <Setor>"` → digitar o código que chega na caixa da conta dona. O nome do servidor tem de 3 a 32 letras, dígitos, espaços e `-`, começando por letra ou dígito (ex.: `"CB rh"`, `"CB rh-juridico"`).
2. Num **perfil separado** do Builders Bot (outro usuário do macOS), entrar com a conta dona: o servidor "CB <Setor>" aparece. **Configurações do servidor → Membros → Convidar pessoas → Link de convite** (uso único, 24 h), função **Admin**, copiar e mandar ao Ariel por canal privado. Sair da conta dona nesse perfil.

**Ariel (e cada membro):**
1. Abrir o Builders Bot com a **conta pessoal** (Cultura Builder ou código por e-mail).
2. Botão **+** da barra de servidores → **Entrar em um servidor** → colar em **Link de convite** → **Revisar convite** → ver **Convite verificado** e **Computador anfitrião verificado** → **Conectar** (packages/i18n/src/messages/pt/server.ts:61-75, 110). **Colar o link, não clicar** (DESIGN 11.4).
3. Na primeira vez: **Configurações do servidor → Provedores** → chave de API do setor; criar os agentes; **Papéis** com Everyone em `none` ou `view`.

**Regras:** uma conta dona por setor, nunca reutilizada; a conta pessoal do Ariel nunca faz login num servidor (a sessão do dono fica no `/data`, que os agentes leem: DESIGN 3.3). Só link de uso único (a aba E-mail falha no fork; não usar "Link permanente"). Sem licença, cada servidor aceita 3 membros ativos com o dono (`packages/contracts/src/input-limits.ts:134-137`): para mais, uma linha `server_member_limits` no D1 `buildersbot-auth` (DESIGN 3.3). Membro com `chat` em qualquer agente vê todos os dados e logins do setor: sigilo forte = outro setor.

**Navegador no servidor:** o `bb-srv-Install` grava `browserInApp: true` (sem isso os agentes usam Playwright no computador da pessoa, DESIGN 5). Login em SaaS: `browser-sign-in-v1` (só no app desktop) ou takeover no live view. Redes sociais podem pedir CAPTCHA em IP de datacenter: setor 24/7 ou `--static-ip`.

## 9. Custo estimado (US$/mês, us-east-1, On-Demand)

Preços conferidos na Pricing API em 31/10/2026: `t4g.small` 0,0168/h, `t4g.medium` 0,0336/h, `t4g.large` 0,0672/h, `t4g.xlarge` 0,1344/h, `m7g.large` 0,0816/h, `t3a.large` 0,0752/h, gp3 0,08/GB-mês; Savings Plan Compute 1 ano sem entrada para `t4g.large` 0,0485/h; alarme 0,10, métrica custom 0,30, IPv4 0,005/h; budgets sem custo. Os demais itens vêm do DESIGN 9.1 (mesma fonte). Volumes de log, snapshot e saída são **[palpite]**.

**Por setor `t4g.large` 24/7 ≈ US$ 63,44:** EC2 49,06 + EBS 60 GB 4,80 + snapshots ~20 GB 1,00 + IPv4 3,65 + logs ~1 GB 0,53 + saída ~20 GB 1,80 + 7 alarmes 0,70 + 4 métricas custom 1,20 (`Healthy`, `mem_used_percent`, `disk_used_percent` do `/data` e do `/`) + ~0,70 que crescem com cada setor **[palpite]**: `PutMetricData` do CloudWatch agent (~1 chamada por minuto, ~43.800 por mês, ~0,44 além da franquia da conta) e Flow Logs da VPC para o S3 (~0,26).
`t4g.medium` 24/7 ≈ **38,91**. `t4g.large` em horário comercial (264 h) ≈ **29,16** (o agent e os Flow Logs só com a VM ligada, ~0,30); com `--static-ip` soma **2,33** (o Elastic IP cobra 3,65 o mês todo, e não 1,32 das horas ligadas). Com live view intenso (~150 GB de saída) ≈ 75,14.
**Pior caso de CPU:** o modo unlimited cobra o que passar da linha de base, até **+40,88** num `t4g.large` a 100% o mês todo (DESIGN 9.1): `t4g.large` 24/7 ≈ **104,32**. O `steady` (`m7g.large`, sem crédito de CPU) custa ≈ **73,95** 24/7: se o alarme `bb-srv-<setor>-cpu-surplus-charged` disparar com frequência (mais de ~US$ 10,50 por mês de crédito cobrado), o `steady` sai mais barato.
**Relay TURN:** o tráfego setor→TURN vai pelo IP público na mesma região e paga 0,01/GB em cada direção, além dos 0,09/GB de saída para a internet: ~0,11 por GB que passa pelo relay (só quando o P2P falha).

**Fixo compartilhado ≈ US$ 23,41:** Signal/TURN 18,71 (EC2 12,26 + IPv4 3,65 + EBS 1,60 + logs 0,30 + 3 alarmes 0,30 + 2 métricas 0,60, `Healthy` e `mem_used_percent`), zona Route 53 0,50, ECR ~2,00, ~4 builds 1,20, Flow Logs da base ~0,50, 5 alarmes da base/backup 0,50. Budgets, EventBridge, SQS e e-mail do SNS ≈ 0.

| Cenário | 1 setor | 5 setores | 20 setores |
|---|---|---|---|
| Todos `t4g.large` 24/7 | **86,85** | **340,61** | **1.292,21** |
| Mix com 20 (6 large 24/7 + 8 medium 24/7 + 6 large horário comercial) | — | — | **890,29** |
| `t4g.large` 24/7 com Savings Plan Compute 1 ano (0,0485/h) | 73,20 | 272,36 | 1.019,21 |
| `t4g.large` 24/7 no pior caso de CPU | 127,73 | 545,01 | 2.109,81 |
| `steady` (`m7g.large`) 24/7 | 97,36 | 393,16 | 1.502,41 |

Fórmula: N × custo por setor + 23,41. A ordem de grandeza é a mesma da estimativa anterior (+1 a 2%). Com 20 setores o Signal provavelmente precisa de `t4g.medium` (+~12) **[palpite]**. Fora desta conta: o uso dos provedores de IA, em geral o maior custo. Contexto: o budget da conta é US$ 400 e o gasto de outubro passou de US$ 2.500 (DESIGN 9.3); quantos setores ligar é decisão do dono.

**Budgets** (dependem das tags de custo ativas, passo 4): cada setor tem um budget próprio cujo padrão segue o tamanho, ~1,25 × a estimativa 24/7 (medium 50, large 80, steady 95, x86 90, xlarge 140; `--budget-usd` troca), com avisos ACTUAL > 80%, ACTUAL > 100% e FORECASTED > 100%. A previsão do AWS Budgets precisa de ~5 semanas de histórico: um setor novo só tem os avisos ACTUAL no começo. O budget do projeto é a **soma dos budgets dos setores + 30** (o fixo com folga), recalculada no fim de cada `add-sector.sh` e `remove-sector.sh` (só esse parâmetro, sobre o template já implantado). Com o piloto `large`: 80 + 30 = 110. Numa atualização, o `deploy-base.sh` mantém o valor, salvo `--project-budget-usd`.

## 10. Operação

- **Estado:** `scripts/status.sh` (tudo) e `scripts/status.sh <setor> --deep` (estado do host por `bb-srv-Status`).
- **Shell de administração** (logado em `/bb-srv/<setor>/ssm-sessions`): `aws --profile cb --region us-east-1 ssm start-session --target <instância> --document-name bb-srv-<setor>-Shell`. Uma sessão sem documento, ou com qualquer documento que não seja o `-Shell` ou o `-Login` **deste** setor (inclusive o de outro setor), gera alerta (regras `bb-srv-<setor>-session-*`). Com a role `bb-srv-operator`, uma sessão sem `--document-name` é negada (checagem de documento na statement da instância).
- **Shell da VM do Signal** (logado em `/bb-srv/signal/ssm-sessions`; o root dessa VM lê os 4 segredos): `… ssm start-session --target <instância do Signal> --document-name bb-srv-signal-Shell`. Sessão sem documento ou com outro documento alerta (regras `bb-srv-signal-session-*`).
- **Atualizar imagem:** `scripts/upgrade-sector.sh <setor> <tag>`; primeiro num setor canário, 24 h, depois os outros. Nunca voltar para imagem mais antiga sobre o mesmo `/data`.
- **Backups:** automáticos (DLM). Setores 24/7: 07:00 UTC com pre/post script (~1-2 min fora do ar entre 04:00 e 05:00 BRT) e semanal domingo 04:00 UTC. Setores em horário comercial: 02:00 UTC com a VM parada. Reboot de patches do SO às 09:30 UTC.
- **Limpeza de snapshots:** nada apaga snapshot por prazo sozinho. A tag `ExpiresAt` (pre-remove e final: `--keep-days`, padrão 180; pre-upgrade: 30 dias) marca quando o `scripts/gc-snapshots.sh` pode apagar. Ele também pega os snapshots do DLM de setores removidos (sem stack `-compute` nem `-data`) com mais de 28 dias, porque o DLM guarda para sempre o último de cada agenda. `scripts/gc-snapshots.sh` só lista; `--delete` apaga depois da confirmação digitada `apagar <N>`. Rodar uma vez por mês.
- **Logs:** `/bb-srv/<setor>` (container, saúde, bootstrap; 30 dias), `/bb-srv/<setor>/ssm-sessions` (90 dias), Flow Logs da VPC em `s3://bb-srv-logs-358748433479/flow/` (90 dias). CloudTrail da conta é o registro confiável.
- **Alertas:** tudo no tópico `bb-srv-alerts`. O alarme de saúde conta as linhas `BB_HEALTH ok`; com a VM ligada, as outras linhas do log publicam 0 (`DefaultValue`), então um container caído alerta também nos setores em horário comercial. Memória e disco ficam no namespace próprio do setor (`bb-srv/<setor>/host`; o Signal em `bb-srv/signal/host`): a role de um host só publica no dele, e nenhum setor esconde os alarmes de outro.

## 11. Rollback e recuperação

| Situação | O que fazer |
|---|---|
| Uma stack falhou na criação | O script mostra os eventos e o caminho exato. `ROLLBACK_COMPLETE` (o normal; a VM de setor nasce sem proteção contra término, então o rollback a apaga): `aws --profile cb --region us-east-1 cloudformation delete-stack --stack-name <stack>` e rodar de novo. Na stack `-compute` de um setor novo, rodar `scripts/add-sector.sh <setor>` de novo reaproveita o volume da stack `-data` (`bb-srv-Install` em modo `auto`) |
| `ROLLBACK_FAILED` ou `DELETE_FAILED` | O `deploy_stack` (e o `status.sh`) imprime os comandos com os ids: `aws … ec2 modify-instance-attribute --instance-id <i> --no-disable-api-termination` para cada VM da stack, depois `aws … cloudformation delete-stack --stack-name <stack>` e `wait stack-delete-complete`. Se um recurso que deve ficar travar o delete: `--retain-resources <LogicalResourceId>` e resolver à mão |
| `UPDATE_ROLLBACK_FAILED` | Corrigir a causa (eventos) e `aws … cloudformation continue-update-rollback --stack-name <stack>` (um recurso que não volta pode ir em `--resources-to-skip`, e fica fora de sincronia) |
| A instalação do setor falhou ou não terminou (stack `-compute` criada) | `scripts/add-sector.sh <setor> --resume`: liga a VM se a agenda a desligou, espera o SSM, repete o `bb-srv-Install` em modo `auto` (com o `.env` no disco faz attach; sem ele, create) e liga a proteção contra término. Se só a proteção ficou de fora, o `--resume` faz só ela. Uma criação interrompida que deixou `/srv/openbot/<setor>` sem `.env` é recusada pelo `bb-srv-Install` (nada é apagado): inspecionar pela sessão `bb-srv-<setor>-Shell` |
| Desfazer um setor | `scripts/remove-sector.sh <setor>` (snapshot completo **antes** de apagar; grava o id em `/bb-srv/sectors/<setor>/final-snapshot`; guardado até alguém rodar `scripts/gc-snapshots.sh --delete` depois do `ExpiresAt`, 180 dias por padrão). Ajusta o budget do projeto no fim. Antes do snapshot, o logout da conta dona: com a VM parada (horário comercial), o script liga a VM para isso; se o `bb-srv-Down` não confirmar o logout (`BB_LOGOUT ok`), só segue com a confirmação digitada `sessao-no-snapshot` (a sessão fica no snapshot e volta numa restauração) |
| Recriar um setor removido | `scripts/add-sector.sh <setor> --from-snapshot <snap>` (mesma identidade, agentes e conversas; novo login). Recusa snapshot de outro setor |
| Upgrade deu errado | Restaurar o snapshot `pre-upgrade` **com a imagem anterior** (tag `PreviousImage` do snapshot): `scripts/remove-sector.sh <setor> --keep-registration` (sem remover no app e sem logout), depois `scripts/add-sector.sh <setor> --from-snapshot <snap-pre-upgrade>`. O modo attach roda a imagem gravada no `.env` do disco restaurado, que é a anterior (só `bb-srv/server` por digest; outra origem é recusada), e o `add-sector.sh` grava em `/bb-srv/sectors/<setor>/image` a imagem que o `bb-srv-Install` informou (linha `BB_IMAGE`), não a do relatório mais novo. `--image-tag` aqui só escolhe o bundle de operação. Nunca rode a imagem nova sobre o disco antigo nem duas cópias do mesmo snapshot |
| VM com defeito (disco bom) ou trocar a AMI | 1) `aws --profile cb --region us-east-1 ec2 stop-instances --instance-ids <i>` e esperar `stopped`; 2) `aws … ec2 modify-instance-attribute --instance-id <i> --no-disable-api-termination`; 3) `aws … cloudformation delete-stack --stack-name bb-srv-<setor>-compute` (o volume fica na stack `-data` e volta a `available`); 4) `scripts/add-sector.sh <setor> <tamanho> --reattach` (VM nova na zona do volume, AMI atual, sem proteção até o fim; `bb-srv-Install` em modo `auto`: attach com a imagem gravada no disco). Antes, se quiser, um snapshot: `aws … ec2 create-snapshot --volume-id <vol>` |
| Atualizar o Signal para outro commit, outro e-mail ACME ou AMI nova | Numa atualização o `deploy-signal.sh` **recusa** outro `--commit` ou `--acme-email` e nunca troca a AMI (ImageId e user data só mudam recriando a VM). Fluxo: `aws --profile cb --region us-east-1 cloudformation delete-stack --stack-name bb-srv-signal`, esperar `stack-delete-complete`, e `scripts/deploy-signal.sh --commit <novo> --acme-email <e-mail>` (resolve a AMI atual uma vez). Os segredos ficam no SSM. O EIP muda e os registros DNS acompanham (TTL 300); conexões novas param ~20 min; as portas voltam fechadas até o `--approve-ingress` |
| Desligar a exposição do Signal | `scripts/deploy-signal.sh` sem `--approve-ingress` (só o `IngressApproved` muda; sem AMI, cota ou DNS no caminho) |
| Sobras da base | O `deploy-base.sh` recusa **criar** a `bb-srv-base` se já existirem `s3://bb-srv-logs-358748433479`, `s3://bb-srv-build-358748433479` ou o ECR `bb-srv/server` (ficaram de uma base apagada). Vazios e dispensáveis: apagar à mão (o bucket de build tem versionamento: apagar também as versões; o ECR só sem imagens, `aws … ecr delete-repository --repository-name bb-srv/server`) e rodar de novo. Com dados que devem ficar (relatórios, imagens, logs): trazê-los para a stack com um change set `IMPORT` (doc da AWS "Bringing existing resources into CloudFormation management") antes de criar o resto. Uma primeira criação que falha não deixa sobras (`RetainExceptOnCreate`) |
| Desfazer tudo | Nesta ordem: 1) remover os setores (`scripts/remove-sector.sh`, um por um); 2) `delete-stack` de `bb-srv-signal`, `bb-srv-ops` e `bb-srv-base`; 3) **dono:** apagar os 4 NS `bb-aws` no Cloudflare e conferir `dig +short NS bb-aws.culturabuilder.com @1.1.1.1` **vazio** (esperar o TTL); 4) **só então** `delete-stack bb-srv-dns` (a zona fica, por política) e apagar a zona à mão: `aws --profile cb --region us-east-1 route53 delete-hosted-zone --id <HostedZoneId>`. Apagar a zona com a delegação ainda no Cloudflare quebra o Signal e deixa o subdomínio pendurado (outra conta poderia criar uma zona com o mesmo nome). Ficam, para apagar à mão e conscientemente: o ECR `bb-srv/server`, os buckets `bb-srv-build-*` (com versões) e `bb-srv-logs-*`, os parâmetros `/bb-srv/signal/*` e os snapshots (`scripts/gc-snapshots.sh` lista) |

Toda atualização de stack passa por change set, e o script **recusa** executar um change set que substitua ou remova instância, volume ou anexo (DESIGN R2-1), a zona Route 53, o ECR ou um bucket (por exemplo `deploy-base.sh --zone <outra>` numa atualização).

## 12. Segurança (resumo)

OWASP/regras do dono: nenhuma porta de entrada nas VMs de setor; nenhuma API sem autenticação (a Team API escuta em `127.0.0.1` e os dados vão por WebRTC/DTLS com ticket ES256 validado pelo host, DESIGN 4.2); nenhum segredo em arquivo versionado, user data, imagem, parâmetro de stack ou saída de script (segredos do Signal guardados só em SSM SecureString, gerados por `openssl` e passados pela entrada padrão). **Limite conhecido:** na VM do Signal, o `remote/compose.yaml` do fork entrega os 4 segredos aos containers como **variáveis de ambiente**: eles aparecem em `docker inspect` (só root) e ficam em `/var/lib/docker/containers/*/config.v2.json`, no disco raiz cifrado da VM; o arquivo de ambiente do compose fica num tmpfs (`/run/bb-srv-signal`, 0600). Quem é root na VM do Signal lê os segredos (o shell é logado e uma sessão fora do documento `bb-srv-signal-Shell` alerta). Na VM do Signal, só o root alcança o IMDS (regra `iptables` da unidade `bb-srv-imds-guard`, antes do Docker): o coturn e o acme usam a rede do host, onde o hop limit 1 não protege, e o coturn roda sem privilégio. A role da VM só altera os dois registros TXT `_acme-challenge.signal.` e `_acme-challenge.turn.` da zona (condições `route53:ChangeResourceRecordSetsNormalizedRecordNames` e `…RecordTypes`): nem com as credenciais dela alguém troca `signal.`/`turn.` ou emite certificado para outro nome. CORS não se aplica (não há API HTTP exposta pelos setores; o Signal só aceita WSS com ticket). **A exceção:** a VM do Signal/TURN abre portas autenticadas, só com `--approve-ingress`, e o coturn nega peers privados (`remote/coturn/turnserver.conf`). GuardDuty está desligado na conta (DESIGN 4.9): ligar é recomendação ao dono.

## 13. Licença do produto

O Builders Bot é **PolyForm Noncommercial 1.0.0** (`package.json:11`; AGENTS.md do fork). O uso pelos setores de uma empresa é uso comercial e exige licença comercial do titular do copyright. **Assunto do dono; esta infraestrutura não resolve isso.**

## 14. Desvios do DESIGN

| DESIGN | Aqui | Motivo |
|---|---|---|
| Nomes `buildersbot-*`, `bb-sector-*`, `BuildersBot-*`; tag `Project=buildersbot` | Prefixo único `bb-srv-`; `Project=buildersbot-servers`, `Owner`, `CostCenter` | Pedido desta tarefa |
| Documentos e DLM na stack base | Stack separada `bb-srv-ops` | O DLM referencia o documento de hooks; e cada template fica abaixo de 51.200 bytes (limite de `--template-body`) |
| Role de serviço `bb-cfn-exec` | Não criada (opcional, decisão do dono) | No lugar: todo script que altera a AWS exige **sessão temporária com MFA** (role `culturabuilder-admin`) e recusa a chave de longa duração, salvo `BB_SRV_ALLOW_LONG_TERM_KEY=1`. Uma role de serviço mínima para EC2, IAM, SSM, Logs, Scheduler, Budgets, DLM, Route 53, S3 e ECR é extensa e não testável sem criar recursos; um erro nela bloquearia o primeiro deploy. O boundary `bb-srv-host-boundary` fica em toda role de setor |
| Zona Route 53 na stack base | Stack própria `bb-srv-dns`, criada antes da base, zona retida (`RetainExceptOnCreate`, `UpdateReplacePolicy: Retain`) | Um rollback ou uma recriação da base não troca os 4 NS: continua uma só ação de DNS do dono |
| `bb-dlm` com `AWSDataLifecycleManagerSSMFullAccess` | Policy própria: `ssm:SendCommand` só no `bb-srv-SnapshotHooks` e só em instâncias `Project=buildersbot-servers` | A gerenciada permite comando em qualquer instância da conta com qualquer documento marcado `DLMScriptsAccess=true` |
| (não especificado) | Buckets e ECR com `RetainExceptOnCreate`; repositório nega só `ecr:BatchDeleteImage` | Uma primeira criação que falha não deixa sobras de nome fixo; um repositório com imagens não é apagado pela stack (sem `EmptyOnDelete`) |
| Trust da role do host com `aws:SourceAccount` | Sem a condição | Se a EC2 não enviar a chave, a VM fica sem credenciais (DESIGN marcou "[validar]"); a proteção real é o `iam:PassRole` |
| (não especificado) | Trust da role `bb-srv-dlm` sem condição; tópico aceita EventBridge só de regras `bb-srv-*` (`aws:SourceArn`) | Uma condição que o DLM não envie pararia todos os backups em silêncio |
| Host sem nenhuma leitura de parâmetro | Lê só `/bb-srv/sectors/<setor>/*` (config do CloudWatch agent); `Deny` explícito no resto, também para `kms:Decrypt` fora desse caminho | Pedido desta tarefa ("read of its own SSM parameters"); mantém a garantia da DESIGN 4.5 para `/hub/prod/*` |
| Sem parâmetro de imagem na stack | `ImageTag` na stack só grava `/bb-srv/sectors/<setor>/image-tag`; a imagem real vai por digest no `bb-srv-Install`/`-Upgrade` | Pedido desta tarefa, sem reintroduzir o drift de R2-1 |
| `lego` no host por timer | O serviço `acme` do próprio compose com `--dns route53` (override, rede do host) | Menos peças; o compose continua o do fork |
| `TURN_PUBLIC_IP=<EIP>` | `<EIP>/<IP privado>` lido do IMDS a cada start | O coturn atrás do NAT 1:1 da EC2 precisa do mapeamento (`external-ip=público/privado`); o entrypoint aceita o valor como está **[inferência; validar no piloto]** |
| `--idle-stop`, `resize`, `grow`, `restore-check`, `gc`, `backups` | `gc` = `scripts/gc-snapshots.sh`; os outros não implementados (`replace`/`rebase` = `add-sector.sh --reattach`) | Escopo. `status.sh` mostra a idade do último snapshot (> 26 h = atrasado). Mudar o tamanho exige também trocar `OPENBOT_MEM` no `.env` do disco (DESIGN 2.6): faça com `--reattach` e o tamanho novo só depois de ajustar o `.env` pela sessão `bb-srv-<setor>-Shell` |
| Builder x86 | Só arm64 | Escopo |

## 15. Não verificado (validar no piloto)

- Nada rodou na AWS: os templates passaram em `validate-template` e na checagem de esquema, mas a criação real pode achar erros de semântica (por exemplo IAM, DLM com scripts, agendas).
- Ubuntu 24.04 + AppArmor + user namespaces no container (docs/docker.md:510-513). Plano B: perfil AppArmor próprio (DESIGN 4.6).
- O build Linux do fork e o nome do executável (bloqueio 1).
- O padrão do evento `StartSession` (campos `target` e `documentName`) nas regras de alerta de sessão, inclusive o `anything-but` com a lista exata `bb-srv-<setor>-Shell`/`-Login`.
- Com a role `bb-srv-operator`: `aws ssm start-session --target <i>` **sem** documento tem de dar AccessDenied (checagem `ssm:SessionDocumentAccessCheck` na statement da instância).
- O alarme `bb-srv-<setor>-health` de um setor em horário comercial dispara com linhas `BB_HEALTH fail` durante o dia (`DefaultValue: 0` no filtro) e fica quieto com a VM parada.
- As dimensões exatas das métricas do CloudWatch agent (`path`, `fstype=ext4`, `Sector`, no namespace próprio `bb-srv/<setor>/host`) usadas no alarme de disco.
- O nome da unidade do SSM agent (snap) para o `OOMScoreAdjust`; o pacote `docker-buildx` no Ubuntu 24.04 do Signal.
- O mapeamento `external-ip` do coturn e o certificado com `lego --dns route53` pela role da VM, já com a condição por nome de registro (`_acme-challenge.signal.`/`turn.`, TXT).
- Que o coturn roda sem privilégio (`docker exec openbot-coturn id -u` diferente de 0), condição para a regra do IMDS da VM do Signal bloqueá-lo; e que o CloudWatch agent, o SSM agent e o `bb-srv-signal-env` (todos root) seguem lendo o IMDS.
- Se as sessões `InteractiveCommands` (`-Login`) também vão para o log de sessão.
- O DLM rodando os pre/post scripts com a policy própria do `bb-srv-dlm` (sem a `AWSDataLifecycleManagerSSMFullAccess`): piloto de backup, passo 14.
- A limpeza de uma primeira criação da `bb-srv-base` que falha (`RetainExceptOnCreate` nos buckets e no ECR, sem o `Deny` de `ecr:DeleteRepository`).
- Os avisos ACTUAL > 100% dos budgets e a atualização do budget do projeto pelo `add-sector.sh`/`remove-sector.sh`.
- A checagem de credencial do `check-access.sh --writes` com o perfil `cb` apontado para a `culturabuilder-admin` (ARN `assumed-role`, aceito sem ler a chave).
- Os números de custo marcados como palpite (logs, saída, snapshots, duração do build, agent e Flow Logs por setor).
